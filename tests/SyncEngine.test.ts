import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncEngine } from '../src/core/SyncEngine.js';
import { 
  SourceProvider, 
  DestinationProvider, 
  StateStore, 
  Logger, 
  SyncCheckpoint,
  MessageMetadata
} from '../src/core/types.js';

describe('SyncEngine', () => {
  let source: vi.Mocked<SourceProvider>;
  let destination: vi.Mocked<DestinationProvider>;
  let state: vi.Mocked<StateStore>;
  let logger: vi.Mocked<Logger>;
  let engine: SyncEngine;

  beforeEach(() => {
    source = {
      name: 'test-source',
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      listCandidateMessages: vi.fn(),
      fetchRawMessage: vi.fn(),
      getAccountId: vi.fn().mockResolvedValue('acc123'),
    } as any;

    destination = {
      name: 'test-dest',
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      ensureReady: vi.fn().mockResolvedValue(undefined),
      storeRawMessage: vi.fn().mockResolvedValue(undefined),
    } as any;

    state = {
      loadCheckpoint: vi.fn().mockResolvedValue({}),
      saveCheckpoint: vi.fn().mockResolvedValue(undefined),
      hasSeen: vi.fn().mockResolvedValue(false),
      markSeen: vi.fn().mockResolvedValue(undefined),
    } as any;

    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as any;

    engine = new SyncEngine(source, destination, state, logger);
  });

  it('should sync messages that have not been seen', async () => {
    const msg: MessageMetadata = {
      id: 'msg1',
      receivedAt: new Date('2023-01-01T00:00:00Z'),
      subject: 'Test subject',
    };

    source.listCandidateMessages.mockResolvedValue([msg]);
    source.fetchRawMessage.mockResolvedValue(Buffer.from('raw content'));

    await engine.run({
      lookbackMinutes: 60,
      maxMessages: 10,
      concurrency: 1,
    });

    expect(destination.storeRawMessage).toHaveBeenCalledWith(
      Buffer.from('raw content'),
      msg,
      expect.anything()
    );
    expect(state.markSeen).toHaveBeenCalled();
    expect(state.saveCheckpoint).toHaveBeenCalledWith('test-source', 'acc123', {
      lastReceivedAt: msg.receivedAt.toISOString(),
      lastMessageId: msg.id,
    });
  });

  it('should skip messages that have already been seen', async () => {
    const msg: MessageMetadata = {
      id: 'msg1',
      receivedAt: new Date('2023-01-01T00:00:00Z'),
      subject: 'Test subject',
    };

    source.listCandidateMessages.mockResolvedValue([msg]);
    state.hasSeen.mockResolvedValue(true);

    await engine.run({
      lookbackMinutes: 60,
      maxMessages: 10,
      concurrency: 1,
    });

    expect(destination.storeRawMessage).not.toHaveBeenCalled();
    expect(state.markSeen).not.toHaveBeenCalled();
  });
});
