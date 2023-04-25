import * as vscode from "vscode";
import * as cp from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import * as semver from "semver";

import { SettingsProvider } from "../providers/settings";
import { SourcemapNode } from "./sourcemap";

export type ProjectRootNode = {
	name: string;
	tree: ProjectOrMetaFileNode;
};

export type ProjectOrMetaFileNode = {
	[key: string]: any | ProjectOrMetaFileNode;
	["$ignoreUnknownInstances"]?: boolean;
	["$className"]?: string;
	["$path"]?: string;
	/**
	 * Extension-only property
	 *
	 * Added by
	 */
	["$filePath"]?: string;
	["$folderPath"]?: string;
};

const ROJO_PROJECT_EXTENSION = ".project.json";
const ROJO_FILE_EXTENSIONS = [
	"server.luau",
	"server.lua",
	"client.luau",
	"client.lua",
	"luau",
	"lua",
];

const globalWatchSupportCache: Map<string, boolean> = new Map();
export const rojoSupportsSourcemapWatch = (cwd: string) => {
	const cached = globalWatchSupportCache.get(cwd);
	if (cached !== undefined) {
		return cached;
	}
	// Rojo version 7.3.0 is the minimum supported version for sourcemap watching
	let supported = true;
	const result = cp.spawnSync("rojo --version", {
		cwd: cwd,
		env: process.env,
		shell: true,
	});
	if (result.status !== null && result.status !== 0) {
		vscode.window.showWarningMessage(
			"Rojo Explorer failed to generate a sourcemap!" +
				"\nMake sure Rojo is installed and available in the current directory."
		);
		supported = false;
	} else {
		const version = result.stdout.toString("utf8").slice(5);
		if (!semver.satisfies(version, "^7.3.0")) {
			vscode.window.showWarningMessage(
				"Rojo Explorer failed to generate a sourcemap!" +
					`\nRojo is installed with version ${version}` +
					", but a minimum version of 7.3.0 is required."
			);
			supported = false;
		}
	}
	globalWatchSupportCache.set(cwd, supported);
	setTimeout(() => {
		globalWatchSupportCache.delete(cwd);
	}, 30_000);
	return supported;
};

export const rojoSourcemapWatch = (
	workspacePath: string,
	settings: SettingsProvider,
	loadingCallback: (child: cp.ChildProcessWithoutNullStreams) => any,
	updateCallback: (
		child: cp.ChildProcessWithoutNullStreams,
		sourcemap: SourcemapNode
	) => any
): cp.ChildProcessWithoutNullStreams => {
	const updateArgs = [
		"sourcemap",
		"--watch",
		settings.get("rojoProjectFile") || "default.project.json",
		settings.get("includeNonScripts") ? "--include-non-scripts" : "",
	];

	const childProcess = cp.spawn("rojo", updateArgs, {
		cwd: workspacePath,
		env: process.env,
		shell: true,
	});

	// Listen for new sourcemaps being generated and output, here we will have to
	// keep track of stdout since data may be received in pieces and incomplete json
	// When we have complete parseable json we will update + clear the current stdout
	let stdout = "";
	loadingCallback(childProcess);
	childProcess.stdout.on("data", (data: Buffer) => {
		if (stdout === "") {
			loadingCallback(childProcess);
		}
		stdout += data.toString("utf8");
		try {
			const sourcemap = JSON.parse(stdout);
			stdout = "";
			updateCallback(childProcess, sourcemap);
		} catch {}
	});

	// Listen for error messages and the child process closing
	let stderr = "";
	childProcess.stderr.on("data", (data: Buffer) => {
		stderr += data.toString("utf8");
	});
	childProcess.on("close", (code: number) => {
		if (childProcess.killed) {
			return;
		}
		if (code !== 0) {
			if (stderr.length > 0) {
				vscode.window.showErrorMessage(
					"Rojo Explorer failed to generate a sourcemap!" +
						`\nRojo exited with code ${code}` +
						`\nMessage:\n${stderr}`
				);
			} else {
				vscode.window.showErrorMessage(
					"Rojo Explorer failed to generate a sourcemap!" +
						`\nRojo exited with code ${code}`
				);
			}
		}
	});

	return childProcess;
};

export const extractRojoFileExtension = (filePath: string): string | null => {
	const fileName = path.basename(filePath);
	for (const ext of ROJO_FILE_EXTENSIONS) {
		if (fileName.endsWith(`.${ext}`)) {
			return ext;
		}
	}
	return null;
};

export const isProjectFilePath = (filePath: string): boolean => {
	return filePath.endsWith(ROJO_PROJECT_EXTENSION);
};

export const isInitFilePath = (filePath: string): boolean => {
	const fileExt = extractRojoFileExtension(filePath);
	if (fileExt) {
		const fileName = path.basename(filePath, `.${fileExt}`);
		return fileName === "init";
	} else {
		return false;
	}
};

/**
 * Caches file system paths from project nodes, also making sure they exist.
 *
 * Does not modify project nodes without a `"$path"` attribute set.
 */
export const cacheProjectFileSystemPaths = async (
	workspacePath: string,
	project: ProjectRootNode
) => {
	const rootAsNode = { [project.name]: project.tree };
	await cacheProjectFileSystemPathsForNode(workspacePath, rootAsNode);
};

const cacheProjectFileSystemPathsForNode = async (
	workspacePath: string,
	projectNode: ProjectOrMetaFileNode
) => {
	const nodePath = projectNode["$path"];
	if (nodePath && typeof nodePath === "string") {
		try {
			const fullPath = path.join(workspacePath, nodePath);
			const stats = await fs.stat(fullPath);
			const isFile = stats.isFile();
			if (isFile) {
				projectNode["$filePath"] = nodePath;
			}
			const isDir = stats.isDirectory();
			if (isDir) {
				projectNode["$folderPath"] = nodePath;
			}
		} catch {}
	}

	const innerPromises: Promise<void>[] = [];
	for (const [projectNodeName, projectNodeInner] of Object.entries(
		projectNode
	)) {
		if (!projectNodeName.startsWith("$")) {
			innerPromises.push(
				cacheProjectFileSystemPathsForNode(
					workspacePath,
					projectNodeInner
				)
			);
		}
	}
	if (innerPromises.length > 0) {
		await Promise.all(innerPromises);
	}
};

/**
 * Merges the given project file into the sourcemap.
 *
 * Does not modify the project file.
 *
 * This adds new `folderPath` properties to sourcemap nodes
 * which point to known folders on the filesystem, which is
 * something that the sourcemap does not contain by default.
 *
 * **NOTE:** Make sure to run `cacheProjectFileSystemPaths` on the
 * project before applying this merge, otherwise this will be a no-op.
 */
export const mergeProjectIntoSourcemap = (
	workspacePath: string,
	project: ProjectRootNode,
	sourcemap: SourcemapNode
) => {
	const rootAsNode = { [project.name]: project.tree };
	const sourcemapAsRoot = {
		className: "<<<ROOT>>>",
		name: "<<<ROOT>>>",
		children: [sourcemap],
	};
	mergeProjectNodeIntoSourcemapNode(
		workspacePath,
		rootAsNode,
		sourcemapAsRoot
	);
};

const mergeProjectNodeIntoSourcemapNode = (
	workspacePath: string,
	projectNode: ProjectOrMetaFileNode,
	sourcemapNode: SourcemapNode
) => {
	const nodeFolderPath = projectNode["$folderPath"];
	if (nodeFolderPath) {
		sourcemapNode.folderPath = nodeFolderPath;
	}
	const nodeFilePath = projectNode["$filePath"];
	if (nodeFilePath) {
		if (sourcemapNode.filePaths) {
			if (!sourcemapNode.filePaths.find((p) => p === nodeFilePath)) {
				sourcemapNode.filePaths.push(nodeFilePath);
			}
		} else {
			sourcemapNode.filePaths = [nodeFilePath];
		}
	}
	if (sourcemapNode.children) {
		for (const [projectNodeName, projectNodeInner] of Object.entries(
			projectNode
		)) {
			if (!projectNodeName.startsWith("$")) {
				let sourcemapNodeInner;
				for (const child of sourcemapNode.children.values()) {
					if (child.name === projectNodeName) {
						sourcemapNodeInner = child;
						break;
					}
				}
				if (sourcemapNodeInner) {
					mergeProjectNodeIntoSourcemapNode(
						workspacePath,
						projectNodeInner,
						sourcemapNodeInner
					);
				}
			}
		}
	}
};
