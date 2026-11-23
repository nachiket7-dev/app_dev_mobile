import { apiFetch, type RequestOptions } from './config.ts';
import type { User } from './types';
import { parseUser, parseUsers } from './validation.ts';

export const userApi = {
  /**
   * List all registered users on the platform.
   * Useful to discover users to start a conversation with.
   * GET /user
   */
  async getAllUsers(options?: RequestOptions): Promise<User[]> {
    return parseUsers(await apiFetch('/user', options));
  },

  /**
   * Get user profile.
   * Returns target user profile if userId is passed, otherwise returns the caller profile.
   * GET /user/profile?user_id=...
   */
  async getUserProfile(userId?: string, options?: RequestOptions): Promise<User> {
    const query = userId ? `?user_id=${encodeURIComponent(userId)}` : '';
    return parseUser(await apiFetch(`/user/profile${query}`, options));
  },
};
