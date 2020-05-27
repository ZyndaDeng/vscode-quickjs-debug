/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from 'vscode';
import { QuickJSDebugSession } from './quickjsDebug';
import * as Net from 'net';

/*
 * Set the following compile time flag to true if the
 * debug adapter should run inside the extension host.
 * Please note: the test suite does not (yet) work in this mode.
 */
const EMBED_DEBUG_ADAPTER = true;

export function activate(context: vscode.ExtensionContext) {
	// register a configuration provider for 'quickjs' debug type
	const provider = new QuickJSConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('quickjs', provider));

	if (EMBED_DEBUG_ADAPTER) {
		// The following use of a DebugAdapter factory shows how to run the debug adapter inside the extension host (and not as a separate process).
		const factory = new QuickJSDebugAdapterDescriptorFactory();
		context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('quickjs', factory));
		context.subscriptions.push(factory);
	} else {
		// The following use of a DebugAdapter factory shows how to control what debug adapter executable is used.
		// Since the code implements the default behavior, it is absolutely not neccessary and we show it here only for educational purpose.
		context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('quickjs', {
			createDebugAdapterDescriptor: (session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined) => {
				// param "executable" contains the executable optionally specified in the package.json (if any)

				// use the executable specified in the package.json if it exists or determine it based on some other information (e.g. the session)
				if (!executable) {
					const command = "absolute path to my DA executable";
					const args = [
						"some args",
						"another arg"
					];
					const options = {
						cwd: "working directory for executable",
						env: { "VAR": "some value" }
					};
					executable = new vscode.DebugAdapterExecutable(command, args, options);
				}

				// make VS Code launch the DA executable
				return executable;
			}
		}));
	}
}

export function deactivate() {
	// nothing to do
}


class QuickJSConfigurationProvider implements vscode.DebugConfigurationProvider {

	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
	resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {
		return config;
	}
}

class QuickJSDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {

	private server?: Net.Server;

	createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {

		if (!this.server) {
			// start listening on a random port
			this.server = Net.createServer(socket => {
				const session = new QuickJSDebugSession();
				session.setRunAsServer(true);
				session.start(<NodeJS.ReadableStream>socket, socket);
			}).listen(0);
		}

		// make VS Code connect to debug server
		return new vscode.DebugAdapterServer((<Net.AddressInfo>this.server.address()).port);
	}

	dispose() {
		if (this.server) {
			this.server.close();
		}
	}
}
