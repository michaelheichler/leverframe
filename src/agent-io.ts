

let agentStdoutMode = false;

export function setAgentStdoutMode(enabled: boolean): void {
  agentStdoutMode = enabled;
}

export function isAgentStdoutMode(): boolean {
  return agentStdoutMode;
}
