export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface IHostExecutor {
  executeCommand(command: string, args: string[], timeoutMs?: number): Promise<CommandResult>;
  executeLocalCommand(command: string, args: string[], timeoutMs?: number): Promise<CommandResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  copyFile(source: string, destination: string): Promise<void>;
  createDirectory(path: string): Promise<void>;
  listDirectory(path: string): Promise<string[]>;
  restartService(unitName: string): Promise<CommandResult>;
  startService(unitName: string): Promise<CommandResult>;
  stopService(unitName: string): Promise<CommandResult>;
  getServiceStatus(unitName: string): Promise<CommandResult>;
  isServiceActive(unitName: string): Promise<boolean>;
  isServiceEnabled(unitName: string): Promise<boolean>;
  enableService(unitName: string): Promise<CommandResult>;
  disableService(unitName: string): Promise<CommandResult>;
  isPortListening(port: number): Promise<boolean>;
}
