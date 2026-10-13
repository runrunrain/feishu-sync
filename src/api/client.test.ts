import { afterEach, describe, expect, it, vi } from 'vitest';
import { APIError, startDeviceAuth } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('device authentication API', () => {
  it('starts same-account reauthentication by default', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ deviceCode: 'test-device' })));
    vi.stubGlobal('fetch', fetchMock);
    await startDeviceAuth();
    expect(fetchMock).toHaveBeenCalledWith('/api/feishu/auth/device/start', expect.objectContaining({
      method: 'POST', body: '{"mode":"reauthorize"}',
    }));
  });

  it.each([
    { body: { error: 'device_auth_start_failed', message: '认证超时，请检查网络后重试' }, message: '认证超时，请检查网络后重试' },
    { body: { error: 'device_auth_in_progress' }, message: 'device_auth_in_progress' },
    { body: { error: { message: 'unexpected shape' } }, message: 'HTTP 502: Bad Gateway' },
  ])('shows the readable failure and preserves structured error data: $message', async ({ body, message }) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 502, statusText: 'Bad Gateway' })));
    await expect(startDeviceAuth()).rejects.toMatchObject({
      name: 'APIError', message, statusCode: 502, response: body,
    });
    await expect(startDeviceAuth()).rejects.toBeInstanceOf(APIError);
  });
});
