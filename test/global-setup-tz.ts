/**
 * Pin the suite's timezone to a non-UTC zone before any worker starts.
 *
 * Several specs prove that a daily key or window follows the UTC day rather
 * than the local one, which only means something on a machine whose local day
 * differs from UTC. Assigning `process.env.TZ` inside a spec does not do it:
 * Jest hands each test file its own copy of `process.env`, so the runtime's
 * zone never changes and the result depends on the machine — green on a
 * developer laptop not in UTC, red on a CI runner in UTC.
 *
 * `globalSetup` runs in the parent process before the workers are spawned, so
 * every worker inherits this value as its real `TZ`.
 */
export default function globalSetup(): void {
  process.env.TZ = 'Pacific/Kiritimati';
}
