# Product usage data

Product usage telemetry is off by default. With the default Settings scope, changing the telemetry
toggle updates the saved preference on every connected environment where settings have loaded and
you have permission to edit them. To opt in, turn on **Share anonymous usage telemetry** under
**Settings > General > Telemetry**. The server uses this setting unless `T3CODE_TELEMETRY_ENABLED`
overrides it. Set the variable to `true` to opt in or `false` to opt out before starting the server.
A managed policy that disables telemetry takes precedence over both.

When enabled, the T3 Code server sends product usage events to T3 Code's own endpoint at
`ingest.t3.codes`, associated with a hashed account or installation identifier. To count how many
installations one person uses, the server also sends hashed identifiers for your T3 Connect, OpenAI,
and Claude accounts when you are signed in, plus a random identifier for each device that connects.
The endpoint keeps a copy of each event and forwards events to PostHog. Events include the provider,
model, reasoning effort, permission mode, turn and request results, duration, release channel, and
token counts when available. Child-agent token counts are reported separately from the main agent's.
Model names are sent only when they appear in a provider's public model list.

Product events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output.

## Relay connection diagnostics

Relay connection tracing is also off by default. When enabled, T3 Code sends these traces to
Axiom to diagnose T3 Connect connectivity. These are separate from product events. Depending on
the client version, traces can include connection timings, environment identifiers, and the
connected machine's name. Failed spans can include error messages and stack traces. Error text
can quote a value the app was handling.

Relay tracing on the server and in the desktop app requires `T3CODE_TELEMETRY_ENABLED=true` before
startup, in addition to a configured exporter. The server can get that configuration from its build
or environment. The desktop client needs it in its build. Set `T3CODE_TELEMETRY_ENABLED=false` to
turn off relay tracing and server product events. Relay tracing also stays off when the OpenTelemetry
SDK is disabled. If both SDK flags are set, `T3CODE_OTEL_SDK_DISABLED` takes precedence over
`OTEL_SDK_DISABLED`, including when the T3 Code flag is set to `false`.

An administrator can block server product events and server and desktop relay tracing even when
`T3CODE_TELEMETRY_ENABLED=true` by setting `telemetry` to `false` in a
[managed policy](./managed-policy.md#other-capabilities).

On macOS and Linux, export `T3CODE_TELEMETRY_ENABLED` in your shell profile (for example `~/.zshrc`)
and restart the desktop app. On Windows, set it as a user environment variable and restart the app.

In a browser, including one opened by the `t3` CLI, relay tracing requires a build with tracing
configured and a saved opt-in. If the browser has a primary environment, only that environment's
**Share anonymous usage telemetry** setting counts. Tracing stays off while that setting is loading
or if it is off. If there is no primary environment, any connected environment with the setting
enabled can opt the browser in. The browser uses the saved setting independently of the server's
environment variables and managed policy.

## Mobile app diagnostics

Mobile crash and startup reporting is on by default when the app has a T3 Connect relay configured.
Crash and error reports include the error message, stack trace, app version, device model, and OS
version. The app also reports startup timings, and every report carries a random ID for the install.
Reports go through the T3 Connect relay to Axiom. They do not include your threads, prompts, or
connection details, but an error message can quote a value the app was handling.

To stop sending them, turn off **Send crash reports** in **Settings > About T3 Code > Diagnostics**.

Mobile relay connection tracing stays off even in builds with tracing configured. The current app
has no user-facing opt-in. **Send crash reports** applies only to crash, error, and startup reports.

## Agent activity for mobile notifications

When **Publish agent activity** is enabled on a host, it sends project and thread titles, model
names, activity status, and environment and thread identifiers to the T3 Connect relay for
[mobile notifications and live activities](./mobile-notifications.md). This is separate from
product events and relay diagnostics. The telemetry opt-out does not disable it.

To stop publishing, turn off **Publish agent activity** under **Settings > Sharing & access** on
the host. Turning off notifications on a phone controls that phone's alerts, not the host's
publishing setting.

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > Maintenance > Diagnostics**, select an environment, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example `http://localhost:4318/v1/traces`). Save, then
restart that environment's server. The receiver must be reachable from the server's machine.
**Test** sends an empty export from the server to check an endpoint before or after you save it;
saved endpoints are checked when the section opens. Checks send authentication headers only to
the signal's currently running endpoint and do not follow redirects. To check a new endpoint
that requires authentication, save it and restart the server first.

`T3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` environment variables override the saved
settings. An overridden signal shows **Set by environment** and names the variable that set it, and its
**Test** checks the running endpoint instead of the field. For endpoints saved here or set with `T3CODE_OTLP_*_URL`, set `T3CODE_OTLP_HEADERS` for
receivers that need authentication and `T3CODE_OTLP_PROTOCOL=http/protobuf` for receivers that do
not accept JSON. An endpoint set with `OTEL_EXPORTER_OTLP_*` takes its headers and protocol from
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_PROTOCOL` instead.
