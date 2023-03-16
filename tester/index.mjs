import { CognitoIdentityProviderClient, AdminInitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";
import {STS} from "@aws-sdk/client-sts";
import {SignatureV4} from "@aws-sdk/signature-v4";
import {HttpRequest} from "@aws-sdk/protocol-http";
import {defaultProvider} from "@aws-sdk/credential-provider-node";
import {URL} from "url";
import {Hash} from "@aws-sdk/hash-node";

import { mergeMap, from, scan, share, toArray, lastValueFrom } from "rxjs";
import fs from "fs/promises";

const testdata = JSON.parse(JSON.parse(process.env.TESTDATA));
const {user, APIs, region} = testdata;

const targetFile = process.argv[2];

const accessToken = (await new CognitoIdentityProviderClient().send(new AdminInitiateAuthCommand({
	AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
	ClientId: user.clientId,
	UserPoolId: user.userPoolId,
	AuthParameters: {
		USERNAME: user.username,
		PASSWORD: user.password,
	}
}))).AuthenticationResult.AccessToken;

const assume = async (sourceCreds, params) => {
	const sts = new STS({credentials: sourceCreds});
	const result = await sts.assumeRole(params);
	if(!result.Credentials) {
		throw new Error("unable to assume credentials - empty credential object");
	}
	return {
		accessKeyId: String(result.Credentials.AccessKeyId),
		secretAccessKey: String(result.Credentials.SecretAccessKey),
		sessionToken: result.Credentials.SessionToken
	}
}

const sendRequest = async (APIURL, type, field, accessToken) => {
	const url = new URL(APIURL);
	const httpRequest = new HttpRequest({
		body: JSON.stringify({
			query: `
query MyQuery {
	${type} {
		${field}
	}
}
`,
			operationName: "MyQuery",
			variables: {},
		}),
		headers: {
			"Content-Type": "application/graphql",
			host: url.hostname,
			...(accessToken ? {authorization: `Bearer ${accessToken}`} : {}),
		},
		hostname: url.hostname,
		method: "POST",
		path: url.pathname,
		protocol: url.protocol,
		query: {},
	});
	const signedIfNeeded  = accessToken ? httpRequest : await (() => {
		const signer = new SignatureV4({
			credentials: defaultProvider({roleAssumer: assume}),
			service: "appsync",
			region: region,
			sha256: Hash.bind(null, "sha256"),
		});
		return signer.sign(httpRequest);
	})();
	const res = await fetch(`${signedIfNeeded.protocol}//${signedIfNeeded.hostname}${signedIfNeeded.path}`, {
		method: signedIfNeeded.method,
		body: signedIfNeeded.body,
		headers: signedIfNeeded.headers,
	});
	if (!res.ok) {
		if (res.status === 401) {
			return false;
		}
		throw res;
	}
	const resJson = await res.json();
	return resJson.data !== null;
}

const requests = APIs.map(({name, url, alldirectives, testIam}) => {
	return alldirectives.map((q_type) => {
		return alldirectives.map((t_type) => {
			return alldirectives.map((field) => {
				return async () => {
					return {
						resultCognito: await sendRequest(url, `q_${q_type[0]}_t_${t_type[0]}`, `f_${field[0]}`, accessToken),
						...(testIam ? {resultIam: await sendRequest(url, `q_${q_type[0]}_t_${t_type[0]}`, `f_${field[0]}`, undefined)} : {}),
						APIname: name,
						...Object.fromEntries(field[1].map((directive, index) => [`f_${index}`, directive])),
						...Object.fromEntries(t_type[1].map((directive, index) => [`t_${index}`, directive])),
						...Object.fromEntries(q_type[1].map((directive, index) => [`q_${index}`, directive])),
					}
				}
			});
		});
	});
}).flat(3);

const results = from(requests).pipe(
	mergeMap((fn) => fn(), 10),
	share(),
);

results.pipe(
	scan((acc) => acc + 1, 0),
).subscribe((val) => {
	console.log(`${val} / ${requests.length}`);
});

const resultValues = await lastValueFrom(results.pipe(toArray()));
await fs.writeFile(targetFile, JSON.stringify({
	results: resultValues,
	config: APIs,
}, undefined, 2), "utf8");
