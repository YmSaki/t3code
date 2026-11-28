import { EnvironmentHttpApi } from "@t3tools/contracts";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

export const environmentHttpApiBaseUrl = (httpBaseUrl: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
};

export const makeEnvironmentHttpApiClient = (httpBaseUrl: string) =>
  HttpApiClient.make(EnvironmentHttpApi, {
    baseUrl: environmentHttpApiBaseUrl(httpBaseUrl),
  });
