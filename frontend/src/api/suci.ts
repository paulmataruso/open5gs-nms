import type { HnetKey, SuciKeysResult, GenerateKeyInput } from '../types/suci';

// Use relative URL to work with nginx proxy
// When VITE_API_URL is empty/undefined, use relative path so requests go through nginx
const API_URL = import.meta.env.VITE_API_URL || '';

export const suciApi = {
  // List all SUCI keys
  async listKeys(): Promise<SuciKeysResult> {
    const res = await fetch(`${API_URL}/api/suci/keys`);
    if (!res.ok) throw new Error('Failed to list SUCI keys');
    return res.json();
  },

  // Get next available PKI ID
  async getNextId(): Promise<number> {
    const res = await fetch(`${API_URL}/api/suci/next-id`);
    if (!res.ok) throw new Error('Failed to get next ID');
    const data = await res.json();
    return data.nextId;
  },

  // Generate new SUCI key
  async generateKey(input: GenerateKeyInput): Promise<HnetKey> {
    const res = await fetch(`${API_URL}/api/suci/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || 'Failed to generate key');
    }
    return res.json();
  },

  // Regenerate existing SUCI key
  async regenerateKey(id: number, scheme: 1 | 2): Promise<HnetKey> {
    const res = await fetch(`${API_URL}/api/suci/keys/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheme }),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || 'Failed to regenerate key');
    }
    return res.json();
  },

  // Delete SUCI key
  async deleteKey(id: number, deleteFile: boolean): Promise<void> {
    const res = await fetch(`${API_URL}/api/suci/keys/${id}?deleteFile=${deleteFile}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || 'Failed to delete key');
    }
  },
};
