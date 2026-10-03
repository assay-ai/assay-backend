import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Custom decorator to extract current user from request
 * Usage: @CurrentUser() user: User
 */
export const CurrentUser = createParamDecorator((data: string, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  const user = request.user;

  return data ? user?.[data] : user;
});
