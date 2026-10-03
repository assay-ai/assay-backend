import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Algorithm } from 'jsonwebtoken';

import { JWT_CONSTANTS } from '../constants/jwt.constants';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, JWT_CONSTANTS.STRATEGY_NAME) {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('jwt.secret'),
      algorithms: [configService.get<string>('jwt.signOptions.algorithm') as Algorithm],
    });
  }

  validate(payload: Record<string, any>) {
    return payload;
  }
}
