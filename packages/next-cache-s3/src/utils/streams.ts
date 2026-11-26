// Vendored to avoid runtime imports from `next/dist/...`. Equivalent to the
// helpers of the same name in Next.
// @see https://github.com/vercel/next.js/blob/v16.3.4/packages/next/src/server/stream-utils/node-web-streams-helper.ts

export async function streamToBuffer(
  stream: ReadableStream<Uint8Array>
): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

export function streamFromBuffer(
  chunk: Uint8Array
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(chunk)
      controller.close()
    },
  })
}
