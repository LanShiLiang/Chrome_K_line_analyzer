import { describe, expect, it, vi } from 'vitest';
import { sendToContentWithRecovery } from '../src/drawer/content-connection';
import { createMessage } from '../src/shared/messages';

const selectionMessage = createMessage('START_SELECTION', 'drawer');

describe('drawer content-script connection recovery', () => {
  it('uses the existing receiver without injecting scripts', async () => {
    const dependencies = {
      sendMessage: vi.fn(async () => ({ ok: true })),
      injectMain: vi.fn(async () => []),
      injectContent: vi.fn(async () => []),
    };

    await expect(sendToContentWithRecovery(7, selectionMessage, dependencies)).resolves.toEqual({
      ok: true,
    });
    expect(dependencies.sendMessage).toHaveBeenCalledOnce();
    expect(dependencies.injectMain).not.toHaveBeenCalled();
    expect(dependencies.injectContent).not.toHaveBeenCalled();
  });

  it('reinjects both bridge layers and retries once when the receiver is missing', async () => {
    const dependencies = {
      sendMessage: vi
        .fn()
        .mockRejectedValueOnce(
          new Error('Could not establish connection. Receiving end does not exist.'),
        )
        .mockResolvedValueOnce({ ok: true }),
      injectMain: vi.fn(async () => []),
      injectContent: vi.fn(async () => []),
    };

    await expect(sendToContentWithRecovery(7, selectionMessage, dependencies)).resolves.toEqual({
      ok: true,
    });
    expect(dependencies.sendMessage).toHaveBeenCalledTimes(2);
    expect(dependencies.injectMain).toHaveBeenCalledWith(7);
    expect(dependencies.injectContent).toHaveBeenCalledWith(7);
    expect(dependencies.injectMain.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.injectContent.mock.invocationCallOrder[0],
    );
    expect(dependencies.injectContent.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.sendMessage.mock.invocationCallOrder[1],
    );
  });

  it('does not inject or retry unrelated messaging failures', async () => {
    const failure = new Error('The tab was closed.');
    const dependencies = {
      sendMessage: vi.fn(async () => {
        throw failure;
      }),
      injectMain: vi.fn(async () => []),
      injectContent: vi.fn(async () => []),
    };

    await expect(sendToContentWithRecovery(7, selectionMessage, dependencies)).rejects.toBe(
      failure,
    );
    expect(dependencies.sendMessage).toHaveBeenCalledOnce();
    expect(dependencies.injectMain).not.toHaveBeenCalled();
    expect(dependencies.injectContent).not.toHaveBeenCalled();
  });
});
