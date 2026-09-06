import { spawn } from "node:child_process";

/**
 * Asking a camera whether it is actually there.
 *
 * Everything else about a camera in this system is hearsay: a status somebody
 * set, a heartbeat from the gateway, a row that says a camera exists because
 * somebody typed it in. This opens the stream and reports what came back, which
 * is the difference between "we believe this camera is online" and "this camera
 * answered, at 1920x1080, in H.264, just now".
 *
 * ffprobe does the work. It is not a Node dependency — it is a binary that has
 * to be on the host, and on a platform where it is not (a serverless function,
 * most obviously) the failure is reported as exactly that rather than as an
 * unreachable camera. Telling an engineer their camera is down when the truth
 * is that the server cannot ask is how an afternoon gets spent on a ladder.
 */

export interface ProbeResult {
  reachable: boolean;
  /** e.g. "1920x1080". Absent when the stream opened but declared no video. */
  resolution?: string;
  /** Rounded to whole frames; the wire format is a rational like "25/1". */
  fps?: number;
  codec?: string;
  /** Present when `reachable` is false. Already trimmed for a screen. */
  error?: string;
}

/** Five seconds inside ffprobe, eight before we stop waiting for ffprobe itself. */
const STREAM_TIMEOUT_US = 5_000_000;
const PROCESS_TIMEOUT_MS = 8_000;

/** "30000/1001" → 29.97. Anything unparseable is simply not reported. */
function parseFrameRate(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const [numerator, denominator = "1"] = value.split("/");
  const n = Number(numerator);
  const d = Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return undefined;
  return n / d;
}

/**
 * Never rejects. Every outcome — unreachable camera, wrong password, missing
 * binary — is a `ProbeResult`, because all of them are answers the screen wants
 * to show and none of them are exceptional.
 *
 * `rtspUrl` carries credentials and must not be logged or returned; only the
 * fields of the result leave this function.
 */
export function probeRtsp(rtspUrl: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];

    let ffprobe: ReturnType<typeof spawn>;
    try {
      ffprobe = spawn("ffprobe", [
        "-rtsp_transport", "tcp",
        "-v", "error",
        "-show_entries", "stream=width,height,r_frame_rate,codec_name",
        "-of", "json",
        "-timeout", String(STREAM_TIMEOUT_US),
        rtspUrl,
      ]);
    } catch (error) {
      resolve({ reachable: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const timer = setTimeout(() => {
      ffprobe.kill("SIGKILL");
      resolve({ reachable: false, error: "The camera did not answer within 8 seconds." });
    }, PROCESS_TIMEOUT_MS);

    ffprobe.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    ffprobe.stderr?.on("data", (chunk: Buffer) => err.push(chunk));

    ffprobe.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({
        reachable: false,
        error:
          error.code === "ENOENT"
            ? "ffprobe is not installed on the API host, so this camera cannot be tested from here."
            : error.message,
      });
    });

    ffprobe.on("close", (code) => {
      clearTimeout(timer);

      if (code !== 0) {
        const message = Buffer.concat(err).toString().trim();
        resolve({
          reachable: false,
          // ffprobe's own words. They are terse but they are specific —
          // "401 Unauthorized" and "Connection refused" send an engineer to two
          // completely different places.
          error: message.slice(0, 300) || `ffprobe exited with code ${code}`,
        });
        return;
      }

      try {
        const parsed = JSON.parse(Buffer.concat(out).toString()) as {
          streams?: { width?: number; height?: number; r_frame_rate?: string; codec_name?: string }[];
        };
        // The first video stream. A camera often publishes audio too, and
        // nobody is asking about that here.
        const stream = parsed.streams?.find((s) => s.width && s.height) ?? parsed.streams?.[0];
        if (!stream) {
          resolve({ reachable: true });
          return;
        }

        const fps = parseFrameRate(stream.r_frame_rate);
        resolve({
          reachable: true,
          resolution: stream.width && stream.height ? `${stream.width}x${stream.height}` : undefined,
          fps: fps === undefined ? undefined : Math.round(fps),
          codec: stream.codec_name,
        });
      } catch {
        // It opened, which is the question that was asked.
        resolve({ reachable: true });
      }
    });
  });
}
