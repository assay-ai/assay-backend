/** Injected by tests; production reads the wall clock. Every T2 time is UTC (NFR-6). */
export const TOOLSET_CLOCK = 'TOOLSET_CLOCK';

export type ToolsetClock = () => Date;

export const systemClock: ToolsetClock = () => new Date();
