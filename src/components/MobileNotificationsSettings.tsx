import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";

import {
  mobileDeviceRemove,
  mobilePairPoll,
  mobilePairStart,
  mobileSendTest,
  mobileStatus,
  openUrl,
  type MobileNotificationStatus,
} from "../lib/ipc";
import type { Channel } from "../lib/version";
import { companionApkUrl } from "../lib/mobileDownloads";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MobileNotificationsSettings({ channel }: { channel: Channel }) {
  const [status, setStatus] = useState<MobileNotificationStatus | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState<"pair" | "test" | "remove" | null>(null);
  const [downloadQr, setDownloadQr] = useState<string | null>(null);
  const [downloadQrBusy, setDownloadQrBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const download = useMemo(() => companionApkUrl(channel), [channel]);

  useEffect(() => {
    setDownloadQr(null);
  }, [download]);

  useEffect(() => {
    let disposed = false;
    void mobileStatus()
      .then((next) => {
        if (!disposed) setStatus(next);
      })
      .catch((error) => {
        if (!disposed) setMessage(errorText(error));
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!status?.pending) return;
    const timer = window.setInterval(() => {
      void mobilePairPoll()
        .then((next) => {
          const paired = status.pending && !next.pending;
          setStatus(next);
          if (paired) {
            setQr(null);
            setMessage("Phone paired. Send a test notification when you are ready.");
            window.dispatchEvent(new Event("duckweed:mobile-paired"));
          }
        })
        .catch((error) => setMessage(errorText(error)));
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [status?.pending?.id]);

  const pair = async () => {
    setBusy("pair");
    setMessage(null);
    try {
      const started = await mobilePairStart();
      setQr(
        await QRCode.toDataURL(started.qrPayload, {
          width: 260,
          margin: 2,
          color: { dark: "#151b16", light: "#ffffff" },
          errorCorrectionLevel: "M",
        }),
      );
      setStatus((current) => ({
        relayUrl: current?.relayUrl ?? "",
        devices: current?.devices ?? [],
        pending: { id: started.id, expiresAt: started.expiresAt },
      }));
      setMessage("Open Duckweed Companion and scan this code within ten minutes.");
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    setBusy("remove");
    setMessage(null);
    try {
      setStatus(await mobileDeviceRemove(id));
      setQr(null);
      setMessage("Phone removed.");
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setMessage(null);
    try {
      const result = await mobileSendTest();
      setMessage(
        result.failed
          ? `Sent to ${result.sent} phone(s); ${result.failed} failed. ${result.errors.join(" ")}`
          : `Test sent to ${result.sent} phone${result.sent === 1 ? "" : "s"}.`,
      );
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(null);
    }
  };

  const toggleDownloadQr = async () => {
    if (downloadQr) {
      setDownloadQr(null);
      return;
    }
    setDownloadQrBusy(true);
    setMessage(null);
    try {
      setDownloadQr(
        await QRCode.toDataURL(download, {
          width: 260,
          margin: 2,
          color: { dark: "#151b16", light: "#ffffff" },
          errorCorrectionLevel: "M",
        }),
      );
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setDownloadQrBusy(false);
    }
  };

  return (
    <section className="settings-section mobile-notifications-settings">
      <h2>Mobile notifications</h2>
      <div className="settings-row mobile-download-row">
        <span className="settings-copy">
          <strong>Duckweed Companion for Android</strong>
          <span>
            Download the latest {channel === "testing" ? "beta" : "stable"} APK. The same
            companion can pair with either desktop channel.
          </span>
        </span>
        <button type="button" className="settings-inline-button" onClick={() => void toggleDownloadQr()}>
          {downloadQrBusy ? "Preparing..." : downloadQr ? "Hide QR code" : "Download APK"}
        </button>
      </div>

      {downloadQr && (
        <div className="mobile-pair-card mobile-download-card">
          <img src={downloadQr} alt={`QR code for the latest ${channel === "testing" ? "beta" : "stable"} Android APK`} />
          <div>
            <strong>Scan to download on your phone</strong>
            <span>
              This QR code opens the latest {channel === "testing" ? "beta" : "stable"} APK. It
              follows the same update channel as this desktop build.
            </span>
            <code>{download}</code>
            <button type="button" className="settings-inline-button" onClick={() => void openUrl(download)}>
              Open download here
            </button>
          </div>
        </div>
      )}

      {(status?.devices ?? []).map((device) => (
        <div className="settings-row mobile-device-row" key={device.id}>
          <span className="settings-copy">
            <strong>{device.name}</strong>
            <span>
              Paired {new Date(device.pairedAt).toLocaleDateString()} · Agent, project, and
              response are encrypted end to end
            </span>
          </span>
          <span className="mobile-device-actions">
            <button type="button" className="settings-inline-button" disabled={busy !== null} onClick={test}>
              {busy === "test" ? "Sending…" : "Send test"}
            </button>
            <button
              type="button"
              className="settings-inline-button is-danger"
              disabled={busy !== null}
              onClick={() => void remove(device.id)}
            >
              Remove
            </button>
          </span>
        </div>
      ))}

      {qr ? (
        <div className="mobile-pair-card">
          <img src={qr} alt="Secure Duckweed Companion pairing QR code" />
          <div>
            <strong>Scan with Duckweed Companion</strong>
            <span>The code expires in ten minutes and can only pair one phone.</span>
            <button
              type="button"
              className="settings-inline-button"
              disabled={busy !== null}
              onClick={() => status?.pending && void remove(status.pending.id)}
            >
              Cancel pairing
            </button>
          </div>
        </div>
      ) : status?.pending ? (
        <div className="settings-row">
          <span className="settings-copy">
            <strong>Pairing in progress</strong>
            <span>Start again to display a fresh QR code on this screen.</span>
          </span>
          <button type="button" className="settings-inline-button" onClick={() => void pair()}>
            New code
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="settings-row settings-action"
          disabled={busy !== null}
          onClick={() => void pair()}
        >
          <span className="settings-copy">
            <strong>Pair a phone</strong>
            <span>Generate a secure QR code for the Android companion</span>
          </span>
          <small className="settings-value">{busy === "pair" ? "Preparing…" : "Pair"}</small>
        </button>
      )}

      {message && <p className="mobile-settings-message" role="status">{message}</p>}
    </section>
  );
}
