import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Delivery, ImageMeta, RuntimeConfig, SessionState } from "./types.js";

const EXTENSION: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

export class ImageError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ImageError";
  }
}

async function downloadOne(
  config: RuntimeConfig,
  state: SessionState,
  image: ImageMeta,
  fetchImpl: typeof fetch,
): Promise<ImageMeta> {
  const extension = EXTENSION[image.mime];
  if (extension === undefined) throw new ImageError("image_mime_denied", `unsupported image MIME: ${image.mime}`);
  if (!Number.isInteger(image.bytes) || image.bytes <= 0 || image.bytes > config.maxImageBytes) {
    throw new ImageError("image_size_denied", `image size is outside the allowed range: ${String(image.bytes)}`);
  }
  if (!/^[a-fA-F0-9]{64}$/.test(image.sha256)) throw new ImageError("image_hash_invalid", "image sha256 is invalid");
  if (image.downloadUrl === undefined || image.downloadUrl === "") {
    throw new ImageError("image_url_missing", "image downloadUrl is missing");
  }
  const response = await fetchImpl(new URL(image.downloadUrl.replace(/^\/+/, ""), `${config.hubUrl}/`), {
    headers: { authorization: `Bearer ${state.resumeToken}` },
  });
  if (!response.ok) throw new ImageError("image_download_failed", `image download returned ${String(response.status)}`);
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > config.maxImageBytes) throw new ImageError("image_size_denied", "image response exceeds maxImageBytes");
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length !== image.bytes) throw new ImageError("image_size_mismatch", "image byte count does not match metadata");
  const digest = createHash("sha256").update(body).digest("hex");
  if (digest.toLowerCase() !== image.sha256.toLowerCase()) throw new ImageError("image_hash_mismatch", "image sha256 does not match metadata");

  const directory = join(config.stateDir, "sessions", state.workspaceId, "inbox", state.conversationId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${randomBytes(12).toString("hex")}${extension}`);
  const partial = `${file}.partial`;
  try {
    writeFileSync(partial, body, { mode: 0o600 });
    renameSync(partial, file);
  } catch (error) {
    try { unlinkSync(partial); } catch { /* best effort */ }
    throw error;
  }
  return { ...image, localPath: file };
}

export async function downloadDeliveryImages(
  config: RuntimeConfig,
  state: SessionState,
  delivery: Delivery,
  fetchImpl: typeof fetch = fetch,
): Promise<Delivery> {
  if (delivery.images.length > config.maxImagesPerMessage) {
    throw new ImageError("too_many_images", `message has ${String(delivery.images.length)} images`);
  }
  const total = delivery.images.reduce((sum, image) => sum + image.bytes, 0);
  if (total > config.maxImagesPerMessage * config.maxImageBytes) {
    throw new ImageError("images_total_too_large", "message images exceed the aggregate limit");
  }
  const images: ImageMeta[] = [];
  for (const image of delivery.images) images.push(await downloadOne(config, state, image, fetchImpl));
  return { ...delivery, images };
}
