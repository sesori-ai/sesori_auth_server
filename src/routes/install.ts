import { FastifyPluginAsync } from "fastify";
import type { InstallScriptService } from "../services/install-script-service.js";

export type InstallRouteOptions = {
  installScriptService: InstallScriptService;
};

export const installRoutes: FastifyPluginAsync<InstallRouteOptions> = async (fastify, opts) => {
  const { installScriptService } = opts;

  fastify.get<{ Reply: string }>("/install.sh", async (_request, reply) => {
    const scriptBody = await installScriptService.getInstallSh();
    reply.type("text/plain").send(scriptBody);
  });

  fastify.get<{ Reply: string }>("/install.ps1", async (_request, reply) => {
    const scriptBody = await installScriptService.getInstallPs1();
    reply.type("text/plain").send(scriptBody);
  });
};
