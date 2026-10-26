import { HANDLE_RE, handleRefusal } from '@modules/toolset/domain/handle';
import {
  NEUTRAL_TOPIC,
  TOOL_TOPICS,
  acceptedTopics,
  topicProblem,
} from '@modules/toolset/domain/topics';

describe('Tool topics: a fixed list plus the categories in use', () => {
  it('accepts a fixed topic no tool uses yet, "other" included', () => {
    // Production has only finance and weather in use: a newcomer still finds a fitting topic.
    const inUse = ['finance', 'weather'];
    for (const topic of ['search', 'data', 'ai', 'media', 'other']) {
      expect(topicProblem(topic, inUse)).toBeNull();
    }
    expect(NEUTRAL_TOPIC).toBe('other');
    expect(TOOL_TOPICS[TOOL_TOPICS.length - 1]).toBe('other');
  });

  it('keeps accepting a category already in use that is not on the list', () => {
    expect(topicProblem('uncategorised', ['uncategorised', 'weather'])).toBeNull();
    expect(acceptedTopics(['weather', 'zeta-legacy', 'alpha-legacy', 'zeta-legacy'])).toEqual([
      ...TOOL_TOPICS,
      'alpha-legacy',
      'zeta-legacy',
    ]);
  });

  it('refuses anything else and names the choices', () => {
    const problem = topicProblem('gardening', ['finance']);
    expect(problem).toContain('category must be one of: weather, finance');
    expect(problem).toContain('other');
  });

  it('reserves every topic as a category name a handle cannot take', () => {
    for (const topic of TOOL_TOPICS.filter((t) => HANDLE_RE.test(t))) {
      expect(handleRefusal(topic)).toBe('RESERVED');
    }
  });
});
