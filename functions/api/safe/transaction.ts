import { handleSafeTxServiceRequest } from "../../../src/server/safeTxService"
import type { RpcGatewayEnv } from "../../../src/server/serverEnv"

export const onRequestPost: PagesFunction<RpcGatewayEnv> = async ({ env, request }) =>
  handleSafeTxServiceRequest(request, env)

export const onRequestGet: PagesFunction<RpcGatewayEnv> = async ({ env, request }) =>
  handleSafeTxServiceRequest(request, env)
