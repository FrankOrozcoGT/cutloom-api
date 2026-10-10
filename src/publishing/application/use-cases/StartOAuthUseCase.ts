import type { PlatformOAuthPort } from '../../domain/ports/PlatformOAuthPort'

/** Genera la URL de autorización — un mismo caso de uso para cualquier plataforma, instanciado una vez por proveedor con su propio PlatformOAuthPort (ver publishingComposition.ts). */
export class StartOAuthUseCase {
  constructor(private readonly oauthProvider: PlatformOAuthPort) {}

  execute(state: string): string {
    return this.oauthProvider.buildAuthorizationUrl(state)
  }
}
