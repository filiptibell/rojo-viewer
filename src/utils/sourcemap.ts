import * as vscode from "vscode";
import * as path from "path";
import * as cp from "child_process";

const fs = vscode.workspace.fs;

const anymatch = require("anymatch");

import { SettingsProvider } from "../providers/settings";
import { RojoTreeProvider } from "../providers/explorer";

import { RobloxReflectionMetadata } from "../web/roblox/reflection";

import {
	ProjectRootNode,
	isInitFilePath,
	mergeProjectIntoSourcemap,
	cacheProjectFileSystemPaths,
	rojoSourcemapWatch,
	isBinaryFilePath,
} from "./rojo";
import { pathMetadata } from "./files";

export type SourcemapNode = {
	name: string;
	className: string;
	folderPath?: string;
	filePaths?: string[];
	children?: SourcemapNode[];
};

const postprocessSourcemapNode = (
	matcher: any | null,
	node: SourcemapNode,
	parent: SourcemapNode | void
): SourcemapNode | null => {
	// Init files have a guaranteed parent directory
	if (!node.folderPath && node.filePaths) {
		for (const filePath of node.filePaths.values()) {
			if (isInitFilePath(filePath)) {
				node.folderPath = path.dirname(filePath);
			}
		}
	}

	// Otherwise we look at the parent of this node and try to
	// join its folder path with this sourcemap node folder name
	if (!node.folderPath && node.className === "Folder") {
		if (parent && parent.folderPath) {
			node.folderPath = path.join(parent.folderPath, node.name);
		}
	}

	// Check if we should keep this sourcemap node using the current glob sets,
	// making sure to always keep at least the root node (node without parent)
	if (parent && matcher) {
		if (node.folderPath && matcher(node.folderPath)) {
			return null;
		} else if (node.filePaths) {
			for (const filePath of node.filePaths.values()) {
				if (matcher(filePath)) {
					return null;
				}
			}
		}
	}

	// Process children and remove them if ignore globs were matched
	if (node.children) {
		const indicesToRemove = [];
		for (const [index, child] of node.children.entries()) {
			if (!postprocessSourcemapNode(matcher, child, node)) {
				indicesToRemove.push(index);
			}
		}
		for (const index of indicesToRemove.reverse()) {
			node.children.splice(index, 1);
		}
	}
	return node;
};

const postprocessSourcemap = (
	workspacePath: string,
	settings: SettingsProvider,
	sourcemap: SourcemapNode
) => {
	const ignoreGlobs = settings.get("sourcemap.ignoreGlobs");
	if (ignoreGlobs && ignoreGlobs.length > 0) {
		postprocessSourcemapNode(anymatch(ignoreGlobs), sourcemap);
	} else {
		postprocessSourcemapNode(null, sourcemap);
	}
};

const PRIMARY_FILE_PRIORITIES = new Map([
	["init.luau", 0],
	["init.lua", 0],
	["init.model.json", 1],
	["init.meta.json", 2],
	[".luau", 3],
	[".lua", 3],
	[".model.json", 4],
	[".meta.json", 5],
]);

const getSortKey = (path: string): number => {
	for (const [ext, value] of PRIMARY_FILE_PRIORITIES) {
		if (path.endsWith(ext)) {
			return value * 1000 + path.length;
		}
	}
	return Infinity;
};

export const findPrimaryFilePath = (
	node: SourcemapNode,
	allowBinaryFiles: boolean | void
): string | null => {
	if (node.filePaths) {
		// Sort and find using ordering - init, lua, model, meta, other
		const sorted = node.filePaths
			.slice() // Copy
			.filter((str) => allowBinaryFiles || !isBinaryFilePath(str))
			.map((str) => [str, getSortKey(str)] as [string, number])
			.sort((a, b) => a[1] - b[1])
			.map((pair) => pair[0]);
		const first = sorted.shift();
		return first ?? null;
	}
	return null;
};

export const getSourcemapNodeTreeOrder = (
	node: SourcemapNode,
	reflectionMetadata: RobloxReflectionMetadata
): number | null => {
	const metadata = reflectionMetadata.Classes.get(node.className);
	if (metadata && metadata.ExplorerOrder) {
		return metadata.ExplorerOrder;
	}
	return null;
};

export const cloneSourcemapNode = (
	node: SourcemapNode,
	deep: boolean | void
): SourcemapNode => {
	const filePaths = node.filePaths ? [...node.filePaths] : undefined;
	const children = node.children ? [...node.children] : undefined;
	if (deep && children) {
		for (const [index, child] of children.entries()) {
			children[index] = cloneSourcemapNode(child, true);
		}
	}
	return {
		name: node.name,
		className: node.className,
		folderPath: node.folderPath,
		filePaths,
		children,
	};
};

// NOTE: We reuse the same arrays here when file paths
// are missing to avoid allocation during the below
// path checks unless it is absolutely necessary
const EMPTY_PATHS_ARRAY: string[] = [];
const EMPTY_CHILDREN_ARRAY: SourcemapNode[] = [];
export const areSourcemapNodesEqual = (
	previous: SourcemapNode | undefined,
	current: SourcemapNode | undefined,
	deep: boolean | void
): boolean => {
	if (
		previous?.folderPath !== current?.folderPath ||
		previous?.className !== current?.className ||
		previous?.name !== current?.name
	) {
		return false;
	}
	if ((previous && previous.filePaths) || (current && current.filePaths)) {
		const previousPaths = previous?.filePaths ?? EMPTY_PATHS_ARRAY;
		const currentPaths = current?.filePaths ?? EMPTY_PATHS_ARRAY;
		if (previousPaths.length !== currentPaths.length) {
			return false;
		} else if (previousPaths.length === 1) {
			if (previousPaths[0] !== currentPaths[0]) {
				return false;
			}
		} else {
			const previousSet = new Set(previousPaths);
			const currentSet = new Set(currentPaths);
			for (const current of currentSet) {
				if (!previousSet.has(current)) {
					return false;
				}
			}
			for (const previous of previousSet) {
				if (!currentSet.has(previous)) {
					return false;
				}
			}
		}
	}
	if (
		deep &&
		((previous && previous.children) || (current && current.children))
	) {
		const previousChildren = previous?.children ?? EMPTY_CHILDREN_ARRAY;
		const currentChildren = current?.children ?? EMPTY_CHILDREN_ARRAY;
		if (previousChildren.length !== currentChildren.length) {
			return false;
		} else if (previousChildren.length === 1) {
			if (
				!areSourcemapNodesEqual(previousChildren[0], currentChildren[0])
			) {
				return false;
			}
		} else {
			const indices = new Set([...previousChildren.keys()]);
			for (const index of currentChildren.keys()) {
				indices.add(index);
			}
			for (const index of indices.values()) {
				if (
					!areSourcemapNodesEqual(
						previousChildren[index],
						currentChildren[index]
					)
				) {
					return false;
				}
			}
		}
	}
	return true;
};

export const connectSourcemapUsingRojo = (
	workspacePath: string,
	settings: SettingsProvider,
	treeProvider: RojoTreeProvider
): [() => boolean, () => void, () => void] => {
	let destroyed: boolean = false;
	let projectFileContents: string | null = null;
	let currentChildProcess: cp.ChildProcessWithoutNullStreams | null = null;

	// Create a file watcher for the project file
	const projectFilePath = `${workspacePath}/${
		settings.get("sourcemap.rojoProjectFile") || "default.project.json"
	}`;
	const projectFileWatcher =
		vscode.workspace.createFileSystemWatcher(projectFilePath);

	// Create the callback that will watch
	// and generate a sourcemap for our tree
	let lastSourcemap: SourcemapNode | undefined;
	const updateProjectFile = async (contents: string | null) => {
		if (projectFileContents !== contents) {
			projectFileContents = contents;
			// Kill any previous child process
			if (currentChildProcess) {
				currentChildProcess.kill();
				currentChildProcess = null;
			}
			// If we got a project file, spawn a new rojo process
			// that will generate sourcemaps and watch for changes
			if (projectFileContents && !destroyed) {
				// Parse the project file and get rid of file paths (not directories)
				let projectFileNode: ProjectRootNode | undefined;
				try {
					projectFileNode = JSON.parse(projectFileContents);
					if (projectFileNode) {
						await cacheProjectFileSystemPaths(
							workspacePath,
							projectFilePath,
							projectFileNode
						);
					}
				} catch (e) {
					vscode.window.showWarningMessage(
						`Failed to read the project file at ${projectFilePath}` +
							"\nSome explorer functionality may not be available" +
							`\n${e}`
					);
				}
				if (destroyed) {
					return;
				}
				// Spawn the rojo process
				const callbacks = {
					loading: (_: any) =>
						treeProvider.setLoading(workspacePath, projectFilePath),
					errored: (_: any, errorMessage: string) =>
						treeProvider.setError(workspacePath, errorMessage),
					update: (_: any, sourcemap: SourcemapNode) => {
						if (projectFileNode) {
							mergeProjectIntoSourcemap(
								workspacePath,
								projectFileNode,
								sourcemap
							);
						}
						postprocessSourcemap(
							workspacePath,
							settings,
							sourcemap
						);
						lastSourcemap = sourcemap;
						treeProvider.clearError(workspacePath);
						treeProvider.update(workspacePath, sourcemap);
					},
				};
				currentChildProcess = rojoSourcemapWatch(
					workspacePath,
					settings,
					callbacks
				);
			}
		}
	};

	// Create callback for manually refreshing and reloading the sourcemap
	const refresh = () => {
		if (lastSourcemap) {
			treeProvider.update(workspacePath, lastSourcemap, true);
			return true;
		} else {
			return false;
		}
	};
	const reload = () => {
		if (destroyed) {
			return;
		}
		rojoSourcemapWatch(workspacePath, settings, {
			loading: () =>
				treeProvider.setLoading(workspacePath, projectFilePath),
			errored: () => {},
			update: (childProcess, sourcemap) => {
				treeProvider.update(workspacePath, sourcemap);
				childProcess.kill();
			},
		});
	};

	// Create callback for disconnecting (destroying)
	// everything created for this workspace folder
	const destroy = () => {
		if (!destroyed) {
			destroyed = true;
			updateProjectFile(null);
			projectFileWatcher.dispose();
			treeProvider.delete(workspacePath);
		}
	};

	// Listen to the project file changing and also read it once initially
	const readProjectFile = async () => {
		if ((await pathMetadata(projectFilePath)).isFile) {
			treeProvider.setLoading(workspacePath, projectFilePath);
			try {
				await fs
					.readFile(vscode.Uri.file(projectFilePath))
					.then((bytes) => bytes.toString())
					.then(updateProjectFile);
			} catch (e) {
				treeProvider.delete(workspacePath);
				vscode.window.showErrorMessage(
					`Failed to read the project file at ${projectFilePath}\n${e}`
				);
			}
		} else {
			treeProvider.delete(workspacePath);
		}
	};
	projectFileWatcher.onDidCreate(readProjectFile);
	projectFileWatcher.onDidChange(readProjectFile);
	projectFileWatcher.onDidDelete(readProjectFile);
	readProjectFile();

	return [refresh, reload, destroy];
};

export const connectSourcemapUsingFile = (
	workspacePath: string,
	settings: SettingsProvider,
	treeProvider: RojoTreeProvider
): [() => boolean, () => void, () => void] => {
	// Create a file watcher for the sourcemap
	const sourcemapPath = `${workspacePath}/sourcemap.json`;
	const fileWatcher = vscode.workspace.createFileSystemWatcher(sourcemapPath);

	// Create callback for refreshing & reloading sourcemap
	let lastSourcemap: SourcemapNode | undefined;
	const refresh = () => {
		if (lastSourcemap) {
			treeProvider.update(workspacePath, lastSourcemap, true);
			return true;
		} else {
			return false;
		}
	};
	const reload = async () => {
		treeProvider.setLoading(workspacePath, sourcemapPath);
		try {
			const sourcemap: SourcemapNode = await fs
				.readFile(vscode.Uri.file(sourcemapPath))
				.then((bytes) => bytes.toString())
				.then(JSON.parse);
			postprocessSourcemap(workspacePath, settings, sourcemap);
			lastSourcemap = sourcemap;
			treeProvider.clearError(workspacePath);
			treeProvider.update(workspacePath, sourcemap);
		} catch (err) {
			const errorMessage = `${err ?? ""}`;
			treeProvider.setError(workspacePath, errorMessage);
		}
	};

	// Create callback for disconnecting (destroying)
	// everything created for this workspace folder
	const destroy = () => {
		treeProvider.delete(workspacePath);
		fileWatcher.dispose();
	};

	// Start watching the sourcemap for changes and update once initially
	fileWatcher.onDidChange(reload);
	reload();

	return [refresh, reload, destroy];
};
