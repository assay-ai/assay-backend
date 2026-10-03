import { Entity, Column, Index } from 'typeorm';
import { AbstractEntity } from './abstract.entity';

@Entity('posts')
export class PostEntity extends AbstractEntity {
  @Column({ name: 'title', type: 'varchar', length: 255 })
  @Index('idx_posts_title')
  title: string;

  @Column({ name: 'content', type: 'text' })
  content: string;

  @Column({ name: 'author', type: 'varchar', length: 100 })
  @Index('idx_posts_author')
  author: string;

  @Column({ name: 'is_published', type: 'boolean', default: false })
  isPublished: boolean;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt: Date | null;
}
