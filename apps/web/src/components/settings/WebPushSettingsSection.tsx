import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { BellIcon, BellRingIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { m } from "~/i18n/messages";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  detectIosSafariPwaState,
  getWebPushSupportStatus,
  sendLocalTestPushNotification,
  subscribeBrowserPush,
  unsubscribeBrowserPush,
  webPushEnvironment,
} from "~/state/webPush";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function WebPushSettingsSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const vapidQuery = useEnvironmentQuery(
    webPushEnvironment.vapidPublicKey({ environmentId, input: {} }),
    resolve,
  );
  const subscriptions = useAtomValue(webPushEnvironment.subscriptionsAtom(environmentId));
  const canManage = useAtomValue(
    webPushEnvironment.subscribe.permissionAtom(environmentId, {
      endpoint: "https://example.invalid",
      keys: { p256dh: "k", auth: "a" },
    }),
  );
  const subscribeRpc = useAtomCommand(webPushEnvironment.subscribe, { reportFailure: false });
  const unsubscribeRpc = useAtomCommand(webPushEnvironment.unsubscribe, { reportFailure: false });

  const [iosStatus] = useState(() => detectIosSafariPwaState());
  const [supportStatus, setSupportStatus] = useState(() => getWebPushSupportStatus());
  const [deviceLabel, setDeviceLabel] = useState("");
  const [subscribedEndpoint, setSubscribedEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const isSubscribed = subscriptions.length > 0 || subscribedEndpoint !== null;

  const handleSubscribeToggle = async (nextChecked: boolean) => {
    setStatusError(null);
    if (!nextChecked) {
      setBusy(true);
      const browserResult = await settlePromise(() => unsubscribeBrowserPush());
      const endpoint =
        browserResult._tag === "Success"
          ? (browserResult.value ?? subscribedEndpoint)
          : subscribedEndpoint;
      if (endpoint) {
        const rpcResult = await unsubscribeRpc({
          environmentId,
          input: { endpoint },
        });
        if (rpcResult._tag === "Failure" && !isAtomCommandInterrupted(rpcResult)) {
          const error = squashAtomCommandFailure(rpcResult);
          setStatusError(
            error instanceof Error
              ? (thrownErrorMessage(error, m) ?? error.message)
              : m(msg("Could not unsubscribe from Web Push.")),
          );
          setBusy(false);
          return;
        }
      }
      setSubscribedEndpoint(null);
      setSupportStatus(getWebPushSupportStatus());
      setBusy(false);
      return;
    }

    const vapidKey = vapidQuery.data?.publicKey;
    if (!vapidKey) {
      setStatusError(gt("VAPID public key is not available from this server yet."));
      return;
    }

    setBusy(true);
    const pushResult = await settlePromise(() => subscribeBrowserPush(vapidKey));
    if (pushResult._tag === "Failure") {
      setStatusError(
        pushResult.cause instanceof Error
          ? pushResult.cause.message
          : gt("Could not enable browser push notifications."),
      );
      setSupportStatus(getWebPushSupportStatus());
      setBusy(false);
      return;
    }

    const trimmedLabel = deviceLabel.trim();
    const rpcResult = await subscribeRpc({
      environmentId,
      input: {
        endpoint: pushResult.value.endpoint,
        keys: pushResult.value.keys,
        ...(trimmedLabel.length > 0 ? { deviceLabel: trimmedLabel } : {}),
        enabled: true,
      },
    });
    setSupportStatus(getWebPushSupportStatus());
    setBusy(false);

    if (rpcResult._tag === "Failure" && !isAtomCommandInterrupted(rpcResult)) {
      const error = squashAtomCommandFailure(rpcResult);
      setStatusError(
        error instanceof Error
          ? (thrownErrorMessage(error, m) ?? error.message)
          : m(msg("Could not register Web Push subscription on the server.")),
      );
      return;
    }

    setSubscribedEndpoint(pushResult.value.endpoint);
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: gt("Web Push enabled on this device"),
      }),
    );
  };

  const handleSendTest = async () => {
    setStatusError(null);
    setBusy(true);
    const testResult = await settlePromise(() =>
      sendLocalTestPushNotification(
        gt("T3 Code test notification"),
        gt("Web Push notifications are active on this device."),
      ),
    );
    setSupportStatus(getWebPushSupportStatus());
    setBusy(false);

    if (testResult._tag === "Failure") {
      setStatusError(
        testResult.cause instanceof Error
          ? testResult.cause.message
          : gt("Could not display a test notification."),
      );
      return;
    }
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: gt("Test notification sent"),
      }),
    );
  };

  return (
    <SettingsSection id="web-push" title={gt("Web Push notifications")} icon={<BellIcon />}>
      {iosStatus.needsHomeScreenInstall ? (
        <Alert variant="info">
          <AlertTitle>{gt("Add to Home Screen required on iOS Safari")}</AlertTitle>
          <AlertDescription>
            {gt(
              "To receive Web Push notifications on iOS, tap Share in Safari, choose Add to Home Screen, and open T3 Code from the home screen icon.",
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      {!supportStatus.supported && !iosStatus.needsHomeScreenInstall ? (
        <Alert variant="warning">
          <AlertTitle>{gt("Web Push is unavailable in this browser context")}</AlertTitle>
          <AlertDescription>
            {gt("Web Push requires HTTPS (such as Tailscale Serve) and Service Worker support.")}
          </AlertDescription>
        </Alert>
      ) : null}

      {statusError !== null ? (
        <Alert variant="error">
          <AlertTitle>{gt("Web Push error")}</AlertTitle>
          <AlertDescription>{statusError}</AlertDescription>
        </Alert>
      ) : null}

      <SettingsRow
        title={gt("Push notifications on this device")}
        description={gt(
          "Receive agent approval requests, questions, and completion alerts directly in this browser or installed PWA.",
        )}
        control={
          <Switch
            checked={isSubscribed}
            disabled={busy || !canManage || !supportStatus.supported || vapidQuery.data === null}
            onCheckedChange={(checked) => {
              void handleSubscribeToggle(checked);
            }}
          />
        }
      />

      <SettingsRow
        title={gt("Device label")}
        description={gt("Optional name shown in your push subscription list.")}
        control={
          <div className="flex items-center gap-2">
            <Input
              className="w-44"
              value={deviceLabel}
              placeholder={gt("e.g. Pixel or iPhone")}
              disabled={busy}
              onChange={(event) => {
                setDeviceLabel(event.target.value);
              }}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !supportStatus.supported}
              onClick={() => {
                void handleSendTest();
              }}
            >
              <BellRingIcon />
              {gt("Test")}
            </Button>
          </div>
        }
      />

      {subscriptions.map((sub) => (
        <div key={sub.id} className={ITEM_ROW_CLASSNAME}>
          <div className={ITEM_ROW_INNER_CLASSNAME}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium text-foreground">
                  {sub.deviceLabel ?? gt("Browser device")}
                </span>
                <Badge variant={sub.enabled ? "success" : "secondary"} size="sm">
                  {sub.enabled ? gt("Active") : gt("Paused")}
                </Badge>
              </div>
              <Button
                size="xs"
                variant="ghost-destructive"
                disabled={busy || !canManage}
                onClick={() => {
                  void unsubscribeRpc({
                    environmentId,
                    input: { id: sub.id },
                  });
                }}
              >
                <Trash2Icon />
                {gt("Remove")}
              </Button>
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              <T>
                Endpoint: <Var>{sub.endpoint}</Var>
              </T>
            </p>
          </div>
        </div>
      ))}
    </SettingsSection>
  );
}
