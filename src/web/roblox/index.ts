import * as vscode from "vscode";

import { downloadWithProgress } from "../axios";
import {
	RobloxApiDump,
	deserializeApiDump,
	parseApiDumpFromObject,
	serializeApiDump,
} from "./apiDump";
import {
	RobloxReflectionMetadata,
	deserializeReflection,
	parseReflectionMetadataFromRobloxStudioZip,
	serializeReflection,
} from "./reflection";

export { RobloxApiDump } from "./apiDump";
export { RobloxReflectionMetadata } from "./reflection";

const URL_VERSION = "https://setup.rbxcdn.com/versionQTStudio";
const URL_API_DUMP = "https://setup.rbxcdn.com/%V-API-Dump.json";
const URL_STUDIO = "https://setup.rbxcdn.com/%V-RobloxStudio.zip";

const CACHE_KEY_VERSION = "roblox-version-hash";
const CACHE_PREFIX_API_DUMP = "roblox-api-dump";
const CACHE_PREFIX_REFLECTION = "roblox-reflection";

export const clearRobloxCache = (
	context: vscode.ExtensionContext,
	notify: boolean | void
) => {
	const keysToRemove = [];
	for (const key of context.globalState.keys()) {
		if (
			key.match(CACHE_KEY_VERSION) ||
			key.match(CACHE_PREFIX_API_DUMP) ||
			key.match(CACHE_PREFIX_REFLECTION)
		) {
			keysToRemove.push(key);
		}
	}
	if (keysToRemove.length > 0) {
		for (const key of keysToRemove.values()) {
			context.globalState.update(key, undefined);
		}
		if (notify) {
			vscode.window
				.showInformationMessage(
					"Roblox API cache was cleared successfully." +
						"\n\nReload the workspace for changes to take effect.",
					"Reload Workspace"
				)
				.then((chosen) => {
					if (chosen === "Reload Workspace") {
						vscode.commands.executeCommand(
							"workbench.action.reloadWindow"
						);
					}
				});
		}
	}
};

export const getRobloxCache = (context: vscode.ExtensionContext) => {
	const state = {
		hasVersion: false,
		hasApiDump: false,
		hasReflection: false,
		cachedVersion: undefined as undefined | string,
		cachedApiDump: undefined as undefined | RobloxApiDump,
		cachedReflection: undefined as undefined | RobloxReflectionMetadata,
	};
	try {
		for (const key of context.globalState.keys()) {
			if (key === CACHE_KEY_VERSION) {
				state.cachedVersion = context.globalState.get(key);
			} else if (key.startsWith(CACHE_PREFIX_API_DUMP)) {
				const value = context.globalState.get(key);
				state.cachedApiDump = deserializeApiDump(value);
			} else if (key.startsWith(CACHE_PREFIX_REFLECTION)) {
				const value = context.globalState.get(key);
				state.cachedReflection = deserializeReflection(value);
			}
		}
	} catch (err) {
		clearRobloxCache(context);
		state.cachedVersion = undefined;
		state.cachedApiDump = undefined;
		state.cachedReflection = undefined;
		vscode.window.showWarningMessage(
			"Failed to deserialize cached Roblox API!" +
				"\n\nThe API will re-download automatically." +
				"\n\nMessage:" +
				`${err}`
		);
	}
	state.hasVersion = !!state.cachedVersion;
	state.hasApiDump = !!state.cachedApiDump;
	state.hasReflection = !!state.cachedReflection;
	return state;
};

export const setRobloxCache = (
	context: vscode.ExtensionContext,
	version: string,
	apiDump: RobloxApiDump,
	reflection: RobloxReflectionMetadata
) => {
	clearRobloxCache(context);
	try {
		context.globalState.update(CACHE_KEY_VERSION, version);
		context.globalState.update(
			`${CACHE_PREFIX_API_DUMP}-${version}`,
			serializeApiDump(apiDump)
		);
		context.globalState.update(
			`${CACHE_PREFIX_REFLECTION}-${version}`,
			serializeReflection(reflection)
		);
	} catch (err) {
		vscode.window.showWarningMessage(
			"Failed to cache downloaded Roblox API!" +
				"\n\nThe API will re-download next time VSCode opens." +
				"\n\nMessage:" +
				`${err}`
		);
	}
};

export const initRobloxCache = async (context: vscode.ExtensionContext) => {
	const dev = context.extensionMode === vscode.ExtensionMode.Development;
	const cache = getRobloxCache(context);
	if (dev || !cache.hasVersion || !cache.hasApiDump || !cache.hasReflection) {
		// No roblox cache was found or it was partially
		// missing, treat it as if the cache does not exist
		await vscode.window.withProgress(
			{
				title: "Downloading Roblox API...\n\n",
				location: vscode.ProgressLocation.Notification,
			},
			async (indicator) => {
				try {
					const apiVersion = await downloadWithProgress(
						URL_VERSION,
						(progress) => {
							indicator.report({
								increment: Math.round(progress * 20),
							});
						}
					);

					// NOTE: The progress bar is weighted heavily towards showing changes
					// in downloading the API dump & reflection since those can be quite
					// large and users with a slow connection will get more value there
					let progressApiDump = 0;
					let progressReflection = 0;
					const updateProgress = () => {
						indicator.report({
							increment: Math.round(
								20 +
									40 * progressApiDump +
									40 * progressReflection
							),
						});
					};

					const [apiDumpRaw, apiReflectionRaw] = await Promise.all([
						downloadWithProgress(
							URL_API_DUMP.replace("%V", apiVersion),
							(progress) => {
								progressApiDump = progress;
								updateProgress();
							},
							"json"
						),
						downloadWithProgress(
							URL_STUDIO.replace("%V", apiVersion),
							(progress) => {
								progressReflection = progress;
								updateProgress();
							},
							"arraybuffer"
						),
					]);

					const apiDump = await parseApiDumpFromObject(apiDumpRaw);
					const apiReflection =
						await parseReflectionMetadataFromRobloxStudioZip(
							apiReflectionRaw
						);

					indicator.report({ increment: 100 });
					setRobloxCache(context, apiVersion, apiDump, apiReflection);
				} catch (err) {
					vscode.window.showErrorMessage(
						`Failed to download Roblox API!\n\n${err}`
					);
				}
			}
		);
	} else {
		// A cache was found, we will silently check for a new version,
		// and if a new version was found, download new data with a progress
		// bar, if this fails we instead fall back to the already available cache
		try {
			const apiVersion = await downloadWithProgress(
				URL_VERSION,
				() => {}
			);
			if (apiVersion !== cache.cachedVersion) {
				await vscode.window.withProgress(
					{
						title: "Downloading latest Roblox API...\n\n",
						location: vscode.ProgressLocation.Notification,
					},
					async (indicator) => {
						let progressApiDump = 0;
						let progressReflection = 0;
						const updateProgress = () => {
							indicator.report({
								increment: Math.round(
									50 * progressApiDump +
										50 * progressReflection
								),
							});
						};

						const [apiDumpRaw, apiReflectionRaw] =
							await Promise.all([
								downloadWithProgress(
									URL_API_DUMP.replace("%V", apiVersion),
									(progress) => {
										progressApiDump = progress;
										updateProgress();
									},
									"json"
								),
								downloadWithProgress(
									URL_STUDIO.replace("%V", apiVersion),
									(progress) => {
										progressReflection = progress;
										updateProgress();
									},
									"arraybuffer"
								),
							]);

						const apiDump = await parseApiDumpFromObject(
							apiDumpRaw
						);
						const apiReflection =
							await parseReflectionMetadataFromRobloxStudioZip(
								apiReflectionRaw
							);

						indicator.report({ increment: 100 });
						setRobloxCache(
							context,
							apiVersion,
							apiDump,
							apiReflection
						);
					}
				);
			}
		} catch (err) {
			vscode.window.showErrorMessage(
				"Failed to download the latest Roblox API!" +
					"\n\nInstances may not appear correctly, but the extension will still work." +
					`\n\n${err}`
			);
		}
	}
	return getRobloxCache(context);
};
