import { GITHUB_TEXT_ENCODING } from '../constants/github';

export class InvalidRemoteFile extends Error {}

export function decodeGitBlob(content: string, size: number, limit: number): string {
  try {
    const bytes = Uint8Array.from(atob(content.replace(/\s/g, '')), character => character.charCodeAt(0));
    if (bytes.length !== size || bytes.length > limit) throw new InvalidRemoteFile();
    return new TextDecoder(GITHUB_TEXT_ENCODING, { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    if (error instanceof InvalidRemoteFile || error instanceof DOMException || error instanceof TypeError) {
      throw new InvalidRemoteFile();
    }
    throw error;
  }
}
