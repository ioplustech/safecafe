import type { RpcGatewayEnv } from "../../src/server/serverEnv"
import { handleValidatorsRequest } from "../../src/server/validators"

export const onRequestGet: PagesFunction<RpcGatewayEnv> = async ({ env, request }) =>
  handleValidatorsRequest(request, env)

export const onRequestPost: PagesFunction<RpcGatewayEnv> = async ({ env, request }) =>
  handleValidatorsRequest(request, env)
