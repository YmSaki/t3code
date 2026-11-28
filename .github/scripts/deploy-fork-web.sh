#!/usr/bin/env bash
set -euo pipefail

if [[ -z "$VERCEL_TOKEN" || -z "$VERCEL_ORG_ID" || -z "$VERCEL_PROJECT_ID" ]]; then
  printf '%s\n' 'Set T3CODEJP_WEB_VERCEL_TOKEN, T3CODEJP_WEB_VERCEL_ORG_ID, and T3CODEJP_WEB_VERCEL_PROJECT_ID.' >&2
  exit 1
fi

case "$VITE_HOSTED_APP_CHANNEL" in
  latest)
    release_channel=stable
    domains=("$T3CODE_WEB_LATEST_DOMAIN" "${T3CODE_WEB_ROUTER_URL#https://}")
    ;;
  nightly)
    release_channel=nightly
    domains=("$T3CODE_WEB_NIGHTLY_DOMAIN")
    ;;
  *)
    printf 'Unrecognized hosted Web channel: %s\n' "$VITE_HOSTED_APP_CHANNEL" >&2
    exit 1
    ;;
esac

vercel_args=(--token "$VERCEL_TOKEN" --scope "$VERCEL_ORG_ID")
deployment_output="$(
  vp dlx vercel@53.1.1 deploy --archive=tgz --prod --skip-domain --yes \
    "${vercel_args[@]}" \
    --build-env "APP_VERSION=$APP_VERSION" \
    --build-env "T3CODE_DESKTOP_UPDATE_REPOSITORY=$GITHUB_REPOSITORY" \
    --build-env "T3CODE_DISTRIBUTION=fork" \
    --build-env "T3CODE_CLERK_PUBLISHABLE_KEY=$T3CODE_CLERK_PUBLISHABLE_KEY" \
    --build-env "T3CODE_CLERK_JWT_TEMPLATE=$T3CODE_CLERK_JWT_TEMPLATE" \
    --build-env "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=$T3CODE_CLERK_CLI_OAUTH_CLIENT_ID" \
    --build-env "T3CODE_RELAY_URL=$T3CODE_RELAY_URL" \
    --build-env "VITE_HOSTED_APP_CHANNEL=$VITE_HOSTED_APP_CHANNEL" \
    --build-env "VITE_RELEASE_CHANNEL=$release_channel" \
    --build-env "T3CODE_WEB_ROUTER_URL=$T3CODE_WEB_ROUTER_URL" \
    --build-env "T3CODE_WEB_LATEST_DOMAIN=$T3CODE_WEB_LATEST_DOMAIN" \
    --build-env "T3CODE_WEB_NIGHTLY_DOMAIN=$T3CODE_WEB_NIGHTLY_DOMAIN"
)"
if ! deployment_url="$(printf '%s\n' "$deployment_output" | grep -E '^https://[[:alnum:]-]+\.vercel\.app$')" ||
  [[ "$deployment_url" == *$'\n'* ]]; then
  printf 'Expected one Vercel deployment URL. Output:\n%s\n' "$deployment_output" >&2
  exit 1
fi

for domain in "${domains[@]}"; do
  printf 'Aliasing %s to %s.\n' "$deployment_url" "$domain"
  vp dlx vercel@53.1.1 alias set "$deployment_url" "$domain" "${vercel_args[@]}"
done
