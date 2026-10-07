// A ZIM byte source over a Blob or File (ZimArchive.open): each read is a slice, so even a file of
// 100 GB is never read whole. Works in browsers and on Node (which has Blob too).

export class BlobSource {
  /** @param {Blob} blob */
  constructor(blob) {
    this.blob = blob;
    /** A File's name; for messages. */
    this.name = blob.name || 'archive';
    this.size = blob.size;
  }

  /** `length` bytes at `position`, fewer at the end of the blob. */
  async read(position, length) {
    const end = Math.min(this.size, position + length);
    if (end <= position) return new Uint8Array(0);
    return new Uint8Array(await this.blob.slice(position, end).arrayBuffer());
  }

  async close() {}
}
