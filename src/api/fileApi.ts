import { apiFetch, getApiConfig, type RequestOptions } from './config.ts';
import type { FileDetail, FileMetadata, UploadFilePayload } from './types';
import { parseFile } from './validation.ts';

export const fileApi = {
  /**
   * Upload an image or file as base64 or from a remote URL.
   * POST /file
   */
  async uploadFile(payload: UploadFilePayload, options?: RequestOptions): Promise<FileMetadata> {
    return parseFile(await apiFetch('/file', {
      ...options,
      method: 'POST',
      body: JSON.stringify(payload),
    }));
  },

  /**
   * Get file metadata and base64 contents.
   * GET /file/:id
   */
  async getFile(id: string, options?: RequestOptions): Promise<FileDetail> {
    return apiFetch<FileDetail>(`/file/${encodeURIComponent(id)}`, options);
  },

  /**
   * Returns the direct download/display URL for raw bytes.
   */
  getDownloadUrl(id: string): string {
    const { baseUrl } = getApiConfig();
    return `${baseUrl}/file/${encodeURIComponent(id)}/download`;
  },
};
