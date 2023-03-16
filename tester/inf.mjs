import {
  buildAlgorithmConfiguration,
  growTree,
} from 'tree-garden';
import fs from "fs/promises";
import zlib from "node:zlib";
import {promisify} from "node:util";
import _ from "lodash";
import {randomUUID} from "node:crypto";

const {results, config} = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
const groups = results.reduce((result, measurement) => {
	const currentConfig = config.find(({name}) => name === measurement.APIname);
	const {group, testIam} = currentConfig;
	const addMeasurementToResults = (group, testIam) => (measurement) => (result) => {
		const existingConfigIndex = result.findIndex((existingResult) => existingResult.group === group && existingResult.testIam === testIam);
		if (existingConfigIndex > -1) {
			return result.map((e, i) => i === existingConfigIndex ? {...e, measurements: [...e.measurements, measurement]} : e);
		}else {
			return [...result, {group, testIam, measurements: [measurement]}];
		}
	}
	return _.flow(
		addMeasurementToResults(group, false)(measurement),
		testIam ? addMeasurementToResults(group, true)(measurement) : _.identity
	)(result)
}, []);

const simplifyTree = (tree) => {
	if(tree.isLeaf) {
		if (Object.keys(tree.classCounts).length !== 1) {
			return {
				isLeaf: false,
				chosenSplitCriteria: tree.chosenSplitCriteria,
				childNodes: _.sortBy(Object.entries(tree.dataPartitionsCounts).map(([k, v]) => ({
					keys: [k],
					node: {
						isLeaf: true,
						result: Object.keys(v)[0],
					}
				})), (e) => e.keys[0]),
			};
		}
		return {
			isLeaf: true,
			result: Object.keys(tree.classCounts)[0],
		};
	}else {
		const countNodes = (tree) => tree.isLeaf ? 1 : tree.childNodes.reduce((memo, child) => memo + countNodes(child.node), 1);
		const simplifiedChildNodes = _.sortBy(Object.entries(tree.childNodes).map(([k, v]) => ({
			keys: [k],
			node: simplifyTree(v),
		})), (e) => e.keys.join(" "));
		const mergedChildNodes = simplifiedChildNodes.flatMap((e, i, a) => {
			const sameIndices = _.range(a.length).filter((idx) => _.isEqual(e.node, a[idx].node));
			if (Math.min(...sameIndices) < i) {
				return [];
			}else {
				return [{
					keys: sameIndices.map((idx) => a[idx].keys).flat(),
					node: e.node,
				}];
			}
		});
		return {
			isLeaf: false,
			chosenSplitCriteria: tree.chosenSplitCriteria,
			childNodes: _.sortBy(mergedChildNodes, [(e) => e.node.isLeaf ? (e.node.result === "true" ? "0" : "2") : "1", (e) => countNodes(e.node), (e) => e.keys.join(" ")]),
		};
	}
}

const buildTree = (res, testIam) => {
	const dataSet = res.map(({resultCognito, resultIam, ...rest}) => ({...rest, ...{_class: testIam ? resultIam : resultCognito}}));
	const algorithmConfig = buildAlgorithmConfiguration(dataSet);
	const tree = growTree(algorithmConfig, dataSet);
	return simplifyTree(tree);
}

const printTree = (tree) => {
	const printTreeNode = (node, indent) => {
		console.log(`${" ".repeat(indent * 2)}${node.chosenSplitCriteria}`);
		(node.childNodes ?? []).forEach(({keys, node}) => {
			console.log(`${" ".repeat((indent + 1) * 2)}"${keys.join(", ")}"${node.isLeaf ? ` => ${node.result}` : ""}:`);
			if (!node.isLeaf) {
				printTreeNode(node, indent + 2);
			}
		});
	};

	printTreeNode(tree, 0);
};

const abbrevs = {
	"@aws_iam": {abbrev: "@iam", description: "@aws_iam"},
	"@aws_cognito_user_pools": {abbrev: "@cup", description: "@aws_cognito_user_pools"},
	"@aws_cognito_user_pools(cognito_groups: [\"admin\"])": {abbrev: "@cup(admin)", description: "@aws_cognito_user_pools(cognito_groups: [\"admin\"])"},
	"@aws_cognito_user_pools(cognito_groups: [\"user\"])": {abbrev: "@cup(user)", description: "@aws_cognito_user_pools(cognito_groups: [\"user\"])"},
	"@aws_auth": {abbrev: "@auth", description: "@aws_auth"},
	"@aws_auth(cognito_groups: [\"user\"])": {abbrev: "@auth(user)", description: "@aws_auth(cognito_groups: [\"user\"])"},
	"@aws_auth(cognito_groups: [\"admin\"])": {abbrev: "@auth(admin)", description: "@aws_auth(cognito_groups: [\"admin\"])"},
	"appsync_cognito_only_deny": {abbrev: "default DENY", description: "Default action: DENY"},
	"appsync_cognito_only_allow": {abbrev: "default ALLOW", description: "Default action: ALLOW"},
};

const generatePlantumlNode = (tree) => {
	const id = randomUUID().replaceAll("-", "");
	if(tree.isLeaf) {
		return {id, text: `card "${tree.result === "true" ? "&#10003;" : "&#10007;"}" as ${id} #${tree.result === "true" ? "lightgreen" : "tomato"}`, usedAbbrevs: []};
	}else {
		const childNodes = tree.childNodes.map(({keys, node}) => ({keys, node: generatePlantumlNode(node)}));
		const abbreviatedKeys = childNodes.map(({keys, ...rest}) => ({
			keys: keys.map((k) => abbrevs[k]?.abbrev ?? k),
			abbreviations: keys.flatMap((k) => abbrevs[k] ? [k] : []),
			...rest,
		}));
		return {id, usedAbbrevs: _.uniq([...abbreviatedKeys.flatMap(({node}) => node.usedAbbrevs), ...abbreviatedKeys.flatMap(({abbreviations}) => abbreviations)]), text:`hexagon "${tree.chosenSplitCriteria.join(" ")}" as ${id}
		${abbreviatedKeys.map(({keys, node}) => `
			${node.text}
			${id} --> ${node.id}: ${keys.map((k) => `${k === "" ? "<<empty>>" : k}`).join("\\l|| ")}
		`).join("")}
		`};
	}
}

const encodePlantuml = async (text) => {
	const encoded = await promisify(zlib.deflateRaw)(Buffer.from(unescape(encodeURIComponent(text)), "utf8"), {level: 9});
	const base64Original = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	const base64Puml = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

	return encoded.toString("base64").split("").map((ch) => {
		return base64Puml[base64Original.indexOf(ch)];
	}).join("").replaceAll("=", "");
}


await Promise.all(groups.map(async ({group, testIam, measurements}) => {
	console.log(group, "testIam", testIam);
	const tree = buildTree(measurements, testIam);
	printTree(tree);
	const {text, usedAbbrevs} = generatePlantumlNode(tree);
	const plantumlsource = `
	skinparam RankSep 10
	skinparam NodeSep 10
	title ${config.filter((c) => c.group === group).map(({description}) => description).join("\\n")}\\n using ${testIam ? "IAM" : "Cognito"} auth
	legend
    |= Abbreviation |= Description |
		| q_ | Directive on the Query field |
		| t_ | Directive on the type |
		| f_ | Directive on the field |
	${usedAbbrevs.map((abbrev) => `| ${abbrevs[abbrev].abbrev} | ${abbrevs[abbrev].description} |`).join("\n")}
	endlegend
		${text}
	`
	const url = `https://www.plantuml.com/plantuml/img/${await encodePlantuml(plantumlsource)}`;
	console.log(url)
}));

