export interface ContextBudgetInputs {
  modelContextWindow: number;
  reservedOutput: number;
  systemEstimate: number;
  toolsEstimate: number;
  messageEstimate: number;
  imageEstimate: number;
  safetyOverhead: number;
  estimatorErrorMargin: number;
  recentTailEstimate: number;
  minimumUsefulRoom?: number;
}

export interface ContextBudget {
  highWatermark: number;
  lowWatermark: number;
  availableInput: number;
  compactionRoom: number;
  unableToCompact: boolean;
}

export type HysteresisAction = 'hold' | 'compact' | 'unable_to_compact';

export interface HysteresisState {
  action: 'hold' | 'compact';
}

function nonnegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a nonnegative finite number`);
  return value;
}

export function calculateContextBudget(inputs: ContextBudgetInputs): ContextBudget {
  const window = nonnegative(inputs.modelContextWindow, 'modelContextWindow');
  const reserved = nonnegative(inputs.reservedOutput, 'reservedOutput');
  const fixed = ['systemEstimate', 'toolsEstimate', 'messageEstimate', 'imageEstimate', 'safetyOverhead', 'estimatorErrorMargin', 'recentTailEstimate']
    .map(name => nonnegative(inputs[name as keyof ContextBudgetInputs] as number, name));
  const minimumUsefulRoom = inputs.minimumUsefulRoom === undefined ? 1024 : nonnegative(inputs.minimumUsefulRoom, 'minimumUsefulRoom');
  const availableInput = Math.max(0, window - fixed[0] - fixed[1] - fixed[2] - fixed[3] - fixed[4] - fixed[5] - reserved);
  const compactionRoom = Math.max(0, availableInput - fixed[6]);
  const unableToCompact = compactionRoom < minimumUsefulRoom;
  if (unableToCompact) return { highWatermark: 0, lowWatermark: 0, availableInput, compactionRoom, unableToCompact: true };
  const highWatermark = compactionRoom;
  const lowStep = Math.max(1, Math.ceil((reserved + fixed[4] + fixed[5]) / 2));
  const lowWatermark = Math.max(0, highWatermark - lowStep);
  return { highWatermark, lowWatermark: Math.min(lowWatermark, highWatermark - 1), availableInput, compactionRoom, unableToCompact: false };
}

export function decideContextHysteresis(
  estimatedInput: number,
  budget: Pick<ContextBudget, 'highWatermark' | 'lowWatermark' | 'unableToCompact'>,
  state: HysteresisState,
): HysteresisAction {
  if (!Number.isFinite(estimatedInput) || estimatedInput < 0) throw new Error('estimatedInput must be a nonnegative finite number');
  if (budget.unableToCompact) return 'unable_to_compact';
  if (estimatedInput >= budget.highWatermark) return 'compact';
  if (estimatedInput <= budget.lowWatermark) return 'hold';
  return state.action;
}