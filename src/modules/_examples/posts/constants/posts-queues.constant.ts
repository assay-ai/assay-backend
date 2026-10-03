/**
 * Queue names owned by the posts module.
 *
 * Naming convention: `<entity>.<verb>` in kebab-case. See `docs/architecture.md`.
 */
export enum PostsQueue {
  CREATED = 'posts.created',
}
