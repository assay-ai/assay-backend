import { handleRelay, type RelayEnv } from './relay';

export default {
  async fetch(request: Request, env: RelayEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method !== 'POST' || pathname !== '/v1/relay') {
      return new Response('not found', { status: 404 });
    }
    return handleRelay(request, env, fetch);
  },
};
