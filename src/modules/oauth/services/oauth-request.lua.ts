/**
 * The Lua scripts behind {@link OAuthRequestStore}. Each one reads and writes
 * a pending request in one atomic step, so two browsers, two tabs or two API
 * instances racing on the same request cannot both win (spec §6.3.5).
 *
 * KEYS[1] is always `oauth:req:{rid}`, KEYS[2] (where present)
 * `oauth:req-done:{rid}`. A request is JSON; `cjson` keeps a JSON `null` as
 * `cjson.null`, so an unset field survives a decode and re-encode unchanged.
 *
 * Every write keeps the request's own TTL (`KEEPTTL`): binding or deciding a
 * request never extends its 600 s life.
 */

/**
 * First reader wins. ARGV[1] = the reader's organization id.
 *
 * Returns `{'ok', json}` with the request (now bound), `{'already_decided'}`
 * when this organization already answered it, or `{'not_found'}`: unknown,
 * expired, or bound to (or decided by) another organization. The last three
 * are one answer on purpose, so another organization learns nothing.
 */
export const BIND_SCRIPT = `
local done = redis.call('GET', KEYS[2])
if done then
  if done == ARGV[1] then return {'already_decided'} end
  return {'not_found'}
end
local raw = redis.call('GET', KEYS[1])
if not raw then return {'not_found'} end
local request = cjson.decode(raw)
local bound = request['boundOrganizationId']
if bound == nil or bound == cjson.null then
  request['boundOrganizationId'] = ARGV[1]
  raw = cjson.encode(request)
  redis.call('SET', KEYS[1], raw, 'KEEPTTL')
elseif bound ~= ARGV[1] then
  return {'not_found'}
end
return {'ok', raw}
`;

/**
 * Approve or deny, once. ARGV[1] = the deciding organization id, ARGV[2] =
 * the approval as JSON, or the empty string for a denial, ARGV[3] = the
 * tombstone's TTL in seconds.
 *
 * Binds the request to ARGV[1] if no one has read it yet, records the
 * decision, and writes the tombstone `oauth:req-done:{rid}` holding the
 * organization id, so a second decision (or a reload of the page) answers
 * `already_decided` to that organization and `not_found` to any other.
 */
export const DECIDE_SCRIPT = `
local done = redis.call('GET', KEYS[2])
if done then
  if done == ARGV[1] then return 'already_decided' end
  return 'not_found'
end
local raw = redis.call('GET', KEYS[1])
if not raw then return 'not_found' end
local request = cjson.decode(raw)
local bound = request['boundOrganizationId']
if bound ~= nil and bound ~= cjson.null and bound ~= ARGV[1] then return 'not_found' end
local approval = request['approval']
if (approval ~= nil and approval ~= cjson.null) or request['denied'] == true then
  return 'already_decided'
end
request['boundOrganizationId'] = ARGV[1]
if ARGV[2] == '' then
  request['denied'] = true
else
  request['approval'] = cjson.decode(ARGV[2])
end
redis.call('SET', KEYS[1], cjson.encode(request), 'KEEPTTL')
redis.call('SET', KEYS[2], ARGV[1], 'EX', tonumber(ARGV[3]))
return 'ok'
`;

/** Read and delete in one step (`GETDEL`): a request is taken at most once. */
export const TAKE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if raw then redis.call('DEL', KEYS[1]) end
return raw
`;
