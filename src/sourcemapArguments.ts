
export interface SourcemapArguments {
	/**
	 * Typically the workspace root. localRoot is used to construct a relative path
	 * for source files that are also present in the remoteRoot.
	 * Thus, this argument is not used when files are transpiled and have sourcemaps. See sourceMaps argument.
	 */
	localRoot?: string;
	/**
	 * The default root path of JavaScript files in a remote environment. Used to resolve
	 * files in the VS Code local file system to files in a remote file system.
	 */
	remoteRoot?: string;
	/**
	 * The sourcemaps to load to resolve source files (like Typescript) in a local file system
	 * to absolute paths in the remote file system.
	 * The keys are the paths to the source map.
	 * The values are the remoteRoot for that sourcemapped file.
	 *   Specify null to use the default remoteRoot: '/remote/root/webpack.main.js'
	 *   Specify an empty string to use the relative path: 'webpack.main.js'
	 */
	sourceMaps?: object;
}
