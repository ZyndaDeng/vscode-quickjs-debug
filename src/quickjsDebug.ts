import * as CP from 'child_process';
import { AddressInfo, createConnection, Server, Socket } from 'net';
import { basename } from 'path';
import { MappedPosition } from 'source-map';
import { InitializedEvent, Logger, logger, OutputEvent, Scope, Source, StackFrame, StoppedEvent, TerminatedEvent, Thread, ThreadEvent } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { SourcemapArguments } from './sourcemapArguments';
import { SourcemapSession } from "./sourcemapSession";
const path = require('path');
const Parser = require('stream-parser');
const Transform = require('stream').Transform;
const { Subject } = require('await-notify');

interface CommonArguments extends SourcemapArguments {
	program: string;
	args?: string[];
	cwd?: string;
	runtimeExecutable: string;
	mode: string;
	address: string;
	port: number;
	console?: ConsoleType;
	trace?: boolean;
	jsPath:string;
}
interface LaunchRequestArguments extends CommonArguments, DebugProtocol.LaunchRequestArguments {
}
interface AttachRequestArguments extends CommonArguments, DebugProtocol.AttachRequestArguments {
}

/**
 * Messages from the qjs binary are in big endian length prefix json payloads.
 * The protocol is roughly just the JSON stringification of the requests.
 * Responses are intercepted to translate references into thread scoped references.
 */
class MessageParser extends Transform {
	constructor() {
		super();
		this._bytes(9, this.onLength);
	}

	private onLength(buffer: Buffer) {
		var length = parseInt(buffer.toString(), 16);
		this.emit('length', length);
		this._bytes(length, this.onMessage);
	}

	private onMessage(buffer: Buffer) {
		var json = JSON.parse(buffer.toString());
		this.emit('message', json);
		this._bytes(9, this.onLength);
	}
}
Parser(MessageParser.prototype);

type ConsoleType = 'internalConsole' | 'integratedTerminal' | 'externalTerminal';

interface PendingResponse {
	resolve: Function;
	reject: Function;
}

export class QuickJSDebugSession extends SourcemapSession {
	private static RUNINTERMINAL_TIMEOUT = 5000;

	private _server?: Server;
	private _supportsRunInTerminalRequest = false;
	private _console: ConsoleType = 'internalConsole';
	private _isTerminated: boolean;
	private _threads = new Map<number, Socket>();
	private _requests = new Map<number, PendingResponse>();
	// contains a list of real source files and their source mapped breakpoints.
	// ie: file1.ts -> webpack.main.js:59
	//     file2.ts -> webpack.main.js:555
	// when sending breakpoint messages, perform the mapping, note which mapped files changed,
	// then filter the breakpoint values for those touched files.
	// sending only the mapped breakpoints from file1.ts would clobber existing
	// breakpoints from file2.ts, as they both map to webpack.main.js.
	private _breakpoints = new Map<string, MappedPosition[]>();
	private _stopOnException = false;
	private _stackFrames = new Map<number, number>();
	private _variables = new Map<number, number>();
	private _commonArgs: CommonArguments;
	private _argsSubject = new Subject();
	private _argsReady = (async () => {
		await this._argsSubject.wait();
	})();

	public constructor() {
		super("quickjs-debug.txt");

		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);
	}

	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

		if (typeof args.supportsRunInTerminalRequest === 'boolean') {
			this._supportsRunInTerminalRequest = args.supportsRunInTerminalRequest;
		}

		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// make VS Code to use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = true;
		response.body.exceptionBreakpointFilters = [{
			label: "All Exceptions",
			filter: "exceptions",
		}]

		// make VS Code to support data breakpoints
		// response.body.supportsDataBreakpoints = true;

		// make VS Code to support completion in REPL
		response.body.supportsCompletionsRequest = true;
		response.body.completionTriggerCharacters = [ ".", "[" ];

		// make VS Code to send cancelRequests
		// response.body.supportsCancelRequest = true;

		// make VS Code send the breakpointLocations request
		// response.body.supportsBreakpointLocationsRequest = true;

		response.body.supportsConfigurationDoneRequest = true;

		response.body.supportsTerminateRequest = true;

		this.sendResponse(response);

		this.sendEvent(new InitializedEvent());
	}

	private handleEvent(thread: number, event: any) {
		if (event.type === 'StoppedEvent') {
			if (event.reason !== 'entry')
			this.sendEvent(new StoppedEvent(event.reason, thread));
		}
		else if (event.type === 'terminated') {
			this.onThreadDead(thread, 'program terminated');
		}
	}

	private handleResponse(json: any) {
		var request_seq: number = json.request_seq;
		var pending = this._requests.get(request_seq);
		if (!pending) {
			this.logTrace(`request not found: ${request_seq}`)
			return;
		}
		this._requests.delete(request_seq);
		if (json.error)
			pending.reject(new Error(json.error));
		else
			pending.resolve(json.body);
	}

	private async newSession(thread: number) {
		let files = new Set<string>();
		for (let bps of this._breakpoints.values()) {
			for (let bp of bps) {
				files.add(bp.source);
			}
		}
		for (let file of files) {
			await this.sendBreakpointMessage(thread, file);
		}

		this.sendThreadMessage(thread, {
			type: 'stopOnException',
			stopOnException: this._stopOnException,
		});

		this.sendThreadMessage(thread, { type: 'continue' })
	}

	private onThreadDead(thread: number, reason: string) {
		if (thread) {
			thread = 0;
			var socket = this._threads.get(thread);
			this._threads.delete(thread);
			if (!this._server)
				this._terminated(reason);
			if (socket)
				socket.destroy();
		}
	}


	private onSocket(socket: Socket) {
		var parser = new MessageParser();
		var thread: number = 0;
		parser.on('message', json => {
			this.logTrace(`received ${thread}: ${JSON.stringify(json)}`)
			// the very first message must include the thread id.
			if (!thread) {
				thread = json.event.thread;
				this._threads.set(thread, socket);
				this.newSession(thread);
				this.sendEvent(new ThreadEvent("new", thread));
			}

			if (json.type === 'event') {
				this.handleEvent(thread, json.event);
			}
			else if (json.type === 'response') {
				this.handleResponse(json);
			}
			else {
				this.logTrace(`unknown message ${json.type}`);
			}
		});
		const cleanup = () => {
			if (thread) {
				thread = 0;
				this.onThreadDead(thread, 'socket closed');
			}
		}
		socket.pipe(parser as any);
		socket.on('error', cleanup);
		socket.on('close', cleanup);
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void {
		this.closeServer();
		this.closeSockets();
		this.sendResponse(response);
	}

    protected async attachRequest(response: DebugProtocol.AttachResponse, args: AttachRequestArguments, request?: DebugProtocol.Request) {
		this._commonArgs = args;
		this._argsSubject.notify();
		this.beforeConnection({});
		this.afterConnection();
		this.sendResponse(response);
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {
		this._commonArgs = args;
		this._argsSubject.notify();

		this._commonArgs.localRoot = args.localRoot;
		this.closeServer();

		var env = {};
		try {
			this.beforeConnection(env);
		}
		catch (e) {
			this.sendErrorResponse(response, 17, e.message);
			return;
		}
		var cwd = <string>args.cwd || path.dirname(args.program);

		if (typeof args.console === 'string') {
			switch (args.console) {
				case 'internalConsole':
				case 'integratedTerminal':
				case 'externalTerminal':
					this._console = args.console;
					break;
				default:
					this.sendErrorResponse(response, 2028, `Unknown console type '${args.console}'.`);
					return;
			}
		}

		let qjsArgs = (args.args || []).slice();
		qjsArgs.unshift(args.program);

		if (this._supportsRunInTerminalRequest && (this._console === 'externalTerminal' || this._console === 'integratedTerminal')) {

			const termArgs: DebugProtocol.RunInTerminalRequestArguments = {
				kind: this._console === 'integratedTerminal' ? 'integrated' : 'external',
				title: "QuickJS Debug Console",
				cwd,
				args: qjsArgs,
				env,
			};

			this.runInTerminalRequest(termArgs, QuickJSDebugSession.RUNINTERMINAL_TIMEOUT, runResponse => {
				if (runResponse.success) {
					// this._attach(response, args, port, address, timeout);
				} else {
					this.sendErrorResponse(response, 2011, `Cannot launch debug target in terminal (${runResponse.message}).`);
					// this._terminated('terminal error: ' + runResponse.message);
				}
			});
		} else {
			const options: CP.SpawnOptions = {
				cwd,
				env,
			};

			const nodeProcess = CP.spawn(args.runtimeExecutable, qjsArgs, options);
			nodeProcess.on('error', (error) => {
				// tslint:disable-next-line:no-bitwise
				this.sendErrorResponse(response, 2017, `Cannot launch debug target (${error.message}).`);
				this._terminated(`failed to launch target (${error})`);
			});
			nodeProcess.on('exit', () => {
				this._terminated('target exited');
			});
			nodeProcess.on('close', (code) => {
				this._terminated('target closed');
			});

			this._captureOutput(nodeProcess);
		}

		try {
			this.afterConnection();
		}
		catch (e) {
			this.sendErrorResponse(response, 18, e.message);
			return;
		}

		this.sendResponse(response);
	}


	private beforeConnection(env: any) {
		this.loadSourceMaps();
		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(this._commonArgs.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

		const address = this._commonArgs.address || 'localhost';
		if (this._commonArgs.mode == 'connect') {
			// connect to a quickjs runtime that is instructed to listen for a connection.
			// typically connect should not be used with launching, because it
			// needs to wait for quickjs to spin up and listen.
			// connect should be used with attach.

			if (!this._commonArgs.port)
				throw new Error("Must specify a 'port' for 'connect'");
			env['QUICKJS_DEBUG_LISTEN_ADDRESS'] = `${address}:${this._commonArgs.port}`;
		}
		else {
			this._server = new Server(this.onSocket.bind(this));
			this._server.listen(this._commonArgs.port || 0);
			var port = (<AddressInfo>this._server.address()).port;
			this.log(`QuickJS Debug Port: ${port}`);

			env['QUICKJS_DEBUG_ADDRESS'] = `localhost:${port}`;
		}
	}

	private async afterConnection() {
		if (this._commonArgs.mode == 'connect') {

			var socket;
			for (var attempt = 0; attempt < 10; attempt++) {
				try {
					socket = await new Promise<Socket>((resolve, reject) => {
						var socket = createConnection(this._commonArgs.port, this._commonArgs.address);
						socket.on('connect', () => {
							socket.removeAllListeners();
							resolve(socket)
						});

						socket.on('close', reject);
						socket.on('error', reject);
					});
					break;
				}
				catch (e) {
					await new Promise(resolve => setTimeout(resolve, 1000));
				}
			}

			if (!socket) {
				const address = this._commonArgs.address || 'localhost';
				throw new Error(`Cannot launch connect (${address}:${this._commonArgs.port}).`);
				return;
			}

			this.onSocket(socket);
		}
	}

	private _captureOutput(process: CP.ChildProcess) {
		process.stdout.on('data', (data: string) => {
			this.sendEvent(new OutputEvent(data.toString(), 'stdout'));
		});
		process.stderr.on('data', (data: string) => {
			this.sendEvent(new OutputEvent(data.toString(), 'stderr'));
		});
	}

	async getArguments(): Promise<SourcemapArguments> {
		await this._argsReady;
		return this._commonArgs;
	}

	public async logTrace(message: string) {
		await this._argsReady;
		if (this._commonArgs.trace)
			this.log(message);
	}

	public log(message: string) {
		this.sendEvent(new OutputEvent(message + '\n', 'console'));
	}

	private _terminated(reason: string): void {
		this.log(`Debug Session Ended: ${reason}`);
		this.closeServer();
		this.closeSockets()

		if (!this._isTerminated) {
			this._isTerminated = true;
			this.sendEvent(new TerminatedEvent());
		}
	}

	private async closeServer() {
		if (this._server) {
			this._server.close();
			this._server = undefined;
		}
	}
	private async closeSockets() {
		for (var thread of this._threads.values()) {
			thread.destroy()
		}
		this._threads.clear()
	}

	protected async terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments, request?: DebugProtocol.Request) {
		this.closeServer();
		this.sendResponse(response);
	}

	private getRelativeFile(file:string){
		let jsPath=this._commonArgs.jsPath;

		let ret = path.relative(jsPath, file) as string;
		ret=ret.replace(/\\/g,"/");
		return ret;
	}


	private async sendBreakpointMessage(thread: number, file: string) {
		const breakpoints: DebugProtocol.SourceBreakpoint[] = [];

		for (let bpList of this._breakpoints.values()) {
			for (let bp of bpList.filter(bp => bp.source === file)) {
				breakpoints.push({
					line: bp.line,
					column: bp.column,
				})
			}
		}
		const envelope = {
			type: 'breakpoints',
			breakpoints: {
				path: this.getRelativeFile(file),
				breakpoints: breakpoints.length ? breakpoints : undefined,
			},
		}
		this.sendThreadMessage(thread, envelope);
	}

	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments) {
		response.body = {
			breakpoints: []
		};

		this.logTrace(`setBreakPointsRequest: ${JSON.stringify(args)}`);

		if (!args.source.path) {
			this.sendResponse(response);
			return;
		}

		// before clobbering the map entry, note which files currently have mapped breakpoints.
		const dirtySources = new Set<string>();
		for (const existingBreakpoint of (this._breakpoints.get(args.source.path) || [])) {
			dirtySources.add(existingBreakpoint.source);
		}

		// map the new breakpoints for a file, and mapped files that get touched.
		const bps = args.breakpoints || [];
		const mappedBreakpoints: MappedPosition[] = [];
		for (var bp of bps) {
			const mapped = await this.translateFileLocationToRemote({
				source: args.source.path,
				column: bp.column || 0,
				line: bp.line,
			});

			dirtySources.add(mapped.source);
			mappedBreakpoints.push(mapped);
		}

		// update the entry for this file
		if (args.breakpoints) {
			this._breakpoints.set(args.source.path, mappedBreakpoints);
		}
		else {
			this._breakpoints.delete(args.source.path);
		}

		for (let thread of this._threads.keys()) {
			for (let file of dirtySources) {
				await this.sendBreakpointMessage(thread, file);
			}
		}
		this.sendResponse(response);
	}

	protected setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments, request?: DebugProtocol.Request) {
		this.sendResponse(response);

		this._stopOnException = args.filters.length > 0;

		for (var thread of this._threads.keys()) {
			this.sendThreadMessage(thread, {
				type: 'stopOnException',
				stopOnException: this._stopOnException,
			})
		}
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		response.body = {
			threads: Array.from(this._threads.keys()).map(thread => new Thread(thread, `thread 0x${thread.toString(16)}`))
		}
		this.sendResponse(response);
	}

	protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments) {
		const thread = args.threadId;
		const body = await this.sendThreadRequest(args.threadId, response, args);

		const stackFrames: StackFrame[] = [];
		for (let { id, name, filename, line, column } of body) {
			filename=this._commonArgs.jsPath+filename;
			var mappedId = id + thread;
			this._stackFrames.set(mappedId, thread);

			try {
				const mappedLocation = await this.translateRemoteLocationToLocal({
					source: filename,
					line: line || 0,
					column: column || 0,
				});
				if (!mappedLocation.source)
					throw new Error('map failed');
				const source = new Source(basename(mappedLocation.source), this.convertClientPathToDebugger(mappedLocation.source));
				stackFrames.push(new StackFrame(mappedId, name, source, mappedLocation.line, mappedLocation.column));
			}
			catch (e) {
				stackFrames.push(new StackFrame(mappedId, name, filename, line, column));
			}
		}

		const totalFrames = body.length;

		response.body = {
			stackFrames,
			totalFrames,
		};
		this.sendResponse(response);
	}

	protected async scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments) {
		const thread = this._stackFrames.get(args.frameId);
		if (!thread) {
			this.sendErrorResponse(response, 2030, 'scopesRequest: thread not found');
			return;
		}
		args.frameId -= thread;
		const body = await this.sendThreadRequest(thread, response, args);
		const scopes = body.map(({ name, reference, expensive }) => {
			// todo: use counter mapping
			var mappedReference = reference + thread;
			this._variables.set(mappedReference, thread);
			return new Scope(name, mappedReference, expensive);
		});

		response.body = {
			scopes,
		};
		this.sendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request) {
		const thread = this._variables.get(args.variablesReference);
		if (!thread) {
			this.sendErrorResponse(response, 2030, 'scopesRequest: thread not found');
			return;
		}

		args.variablesReference -= thread;
		const body = await this.sendThreadRequest(thread, response, args);
		const variables = body.map(({ name, value, type, variablesReference, indexedVariables }) => {
			// todo: use counter mapping
			variablesReference = variablesReference ? variablesReference + thread : 0;
			this._variables.set(variablesReference, thread);
			return { name, value, type, variablesReference, indexedVariables };
		});

		response.body = {
			variables,
		}
		this.sendResponse(response);
	}

	private sendThreadMessage(thread: number, envelope: any) {
		var socket = this._threads.get(thread);
		if (!socket) {
			this.logTrace(`socket not found for thread: ${thread.toString(16)}`);
			return;
		}

		this.logTrace(`sent ${thread}: ${JSON.stringify(envelope)}`)

		var json = JSON.stringify(envelope);

		var jsonBuffer = Buffer.from(json);
		// length prefix is 8 hex followed by newline = 012345678\n
		// not efficient, but protocol is then human readable.
		// json = 1 line json + new line
		var messageLength = jsonBuffer.byteLength + 1;
		var length = '00000000' + messageLength.toString(16) + '\n';
		length = length.substr(length.length - 9);
		var lengthBuffer = Buffer.from(length);
		var newline = Buffer.from('\n');
		var buffer = Buffer.concat([lengthBuffer, jsonBuffer, newline]);
		socket.write(buffer);
	}

	private sendThreadRequest(thread: number, response: DebugProtocol.Response, args: any): Promise<any> {
		return new Promise((resolve, reject) => {
			var request_seq = response.request_seq;
			// todo: don't actually need to cache this. can send across wire.
			this._requests.set(request_seq, {
				resolve,
				reject,
			});

			var envelope = {
				type: 'request',
				request: {
					request_seq,
					command: response.command,
					args,
				}
			};

			this.sendThreadMessage(thread, envelope);
		});
	}

	protected async continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments) {
		response.body = await this.sendThreadRequest(args.threadId, response, args);
		this.sendResponse(response);
	}

	protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments) {
		response.body = await this.sendThreadRequest(args.threadId, response, args);
		this.sendResponse(response);
	}

	protected async stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments, request?: DebugProtocol.Request) {
		response.body = await this.sendThreadRequest(args.threadId, response, args);
		this.sendResponse(response);
	}

	protected async stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments, request?: DebugProtocol.Request) {
		response.body = await this.sendThreadRequest(args.threadId, response, args);
		this.sendResponse(response);
	}

	protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments) {
		if (!args.frameId) {
			this.sendErrorResponse(response, 2030, 'scopesRequest: frameId not specified');
			return;
		}
		var thread = this._stackFrames.get(args.frameId);
		if (!thread) {
			this.sendErrorResponse(response, 2030, 'scopesRequest: thread not found');
			return;
		}
		args.frameId -= thread;

		const body = await this.sendThreadRequest(thread, response, args);
		let variablesReference = body.variablesReference;
		variablesReference = variablesReference ? variablesReference + thread : 0;
		this._variables.set(variablesReference, thread);
		body.variablesReference = variablesReference;

		response.body = body;
		this.sendResponse(response);
	}

    protected async pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments, request?: DebugProtocol.Request) {
		response.body = await this.sendThreadRequest(args.threadId, response, args);
		this.sendResponse(response);
	}

	protected async completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments) {
		if (!args.frameId) {
			this.sendErrorResponse(response, 2030, 'completionsRequest: frameId not specified');
			return;
		}
		var thread = this._stackFrames.get(args.frameId);
		if (!thread) {
			this.sendErrorResponse(response, 2030, 'completionsRequest: thread not found');
			return;
		}
		args.frameId -= thread;

		var expression = args.text.substr(0, args.text.length - 1);
		if (!expression) {
			this.sendErrorResponse(response, 2032, "no completion available for empty string")
			return;
		}

		const evaluateArgs: DebugProtocol.EvaluateArguments = {
			frameId: args.frameId,
			expression,
		}
		response.command = 'evaluate';

		var body = await this.sendThreadRequest(thread, response, evaluateArgs);
		if (!body.variablesReference) {
			this.sendErrorResponse(response, 2032, "no completion available for expression");
			return;
		}

		if (body.indexedVariables !== undefined) {
			this.sendErrorResponse(response, 2032, "no completion available for arrays");
			return;
		}

		const variableArgs: DebugProtocol.VariablesArguments = {
			variablesReference: body.variablesReference,
		}
		response.command = 'variables';
		body = await this.sendThreadRequest(thread, response, variableArgs);

		response.command = 'completions';
		response.body = {
			targets: body.map(property => ({
				label: property.name,
				type: 'field',
			}))
		}

		this.sendResponse(response);
	}
}
