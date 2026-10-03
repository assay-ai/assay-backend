import { createErrorFactory } from '@shared/errors/app-errors';

export const PostErrors = createErrorFactory({
  postNotFound: {
    code: 'POST_NOT_FOUND',
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `Post not found${context?.id ? ` with id: ${context.id}` : ''}`,
  },
  postAlreadyExists: {
    code: 'POST_ALREADY_EXISTS',
    statusCode: 409,
    message: (context?: Record<string, any>) =>
      `Post already exists${context?.title ? ` with title: ${context.title}` : ''}`,
  },
});
