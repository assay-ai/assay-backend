import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PostEntity } from '../entities/post.entity';
import { AbstractRepository } from './abstract.repository';

@Injectable()
export class PostRepository extends AbstractRepository<PostEntity> {
  constructor(@InjectDataSource('postgres') protected readonly dataSource: DataSource) {
    super(PostEntity, dataSource);
  }
}
