import { spinner } from '@clack/prompts';
import pc from 'picocolors';

/** Validates an Anthropic API key by making a minimal request to the API. */
export async function verifyApiKey(apiKey: string): Promise<boolean> {
  const s = spinner();
  s.start(`🔑 Validating API key (${apiKey.slice(0, 10)}...)`);
  
  try {
    // We use a small request to the messages API with max_tokens: 1 to minimize cost
    // and verify the key is active.
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      // Set a timeout of 15 seconds as suggested by user's output
      signal: AbortSignal.timeout(15000), 
    });

    if (response.ok) {
      s.stop(pc.green('✔ API Key is valid.'));
      return true;
    } else {
      const data: any = await response.json().catch(() => ({}));
      const errorMsg = data.error?.message || response.statusText;
      s.stop(pc.red(`❌ Key validation FAILED: ${errorMsg}`));
      return false;
    }
  } catch (e: any) {
    const errorMsg = e.name === 'TimeoutError' ? 'timeout' : e.message;
    s.stop(pc.red(`❌ Key validation FAILED: ${errorMsg}`));
    return false;
  }
}
