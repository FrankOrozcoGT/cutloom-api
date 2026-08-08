# Arquitectura general — CutLoom API

Este documento cubre lo que siempre debe saberse sobre este repo: principios, capas y reglas generales. No describe features concretas (eso vive en la capa de navegación/planning) ni implementación (eso vive en el código).

## Principios

- **Clean Architecture**: el dominio no depende de infraestructura. Los casos de uso dependen de puertos (interfaces); las implementaciones concretas (DB, colas, proveedores externos) viven en la capa de infraestructura y se inyectan.
- **DDD (Domain-Driven Design)**: el sistema se organiza en bounded contexts, cada uno con su propio lenguaje y modelo. Las reglas de negocio (qué puede hacer un tenant, qué es un entitlement) viven en el dominio, no en middlewares ni controllers.

## Capas (por bounded context)

Cada bounded context sigue la misma estructura interna:

- **domain/** — Entidades, Value Objects, reglas de negocio puras. Sin dependencias externas.
- **application/** — Casos de uso (use cases). Orquestan el dominio, dependen de puertos (interfaces), no de implementaciones.
- **infrastructure/** — Implementaciones concretas de los puertos: acceso a PostgreSQL, colas de jobs, clientes HTTP a APIs externas (YouTube, TikTok, LLM, etc.).

## Bounded contexts

| Contexto | Responsabilidad |
|---|---|
| **Identity/Tenancy** | Organización, Usuario, Membership (rol dentro de la org) |
| **Media Editing** | Proyecto de video, Clips, Timeline, cortes (capa gratuita) |
| **Shorts Intelligence** | Pipeline de detección de shorts, candidatos, emociones (capa premium) |
| **Publishing** | OAuth y publicación a YouTube/TikTok |
| **Billing** | Entitlements, suscripciones, donaciones |

## Multitenancy

- El tenant es una **Organización**, no un usuario individual — un usuario pertenece a una organización vía Membership (con rol). Un creador individual es, en la práctica, el único miembro de su propia organización.
- Aislamiento de datos: **single database, `tenant_id` en cada tabla**. Toda query de aplicación filtra por `tenant_id`. No hay schema-per-tenant por ahora — se evalúa migrar si la escala lo justifica.

## Modelo free/paid (Entitlements)

La distinción entre features gratuitas y pagas es una regla de **dominio**, no un `if` disperso en controllers:

- `Entitlement` es un concepto del bounded context **Billing**: `{ tenantId, feature, active }`.
- Los casos de uso de features premium dependen de un puerto `EntitlementChecker` (definido en `application/`, implementado en `infrastructure/`). El caso de uso pregunta "¿este tenant tiene el entitlement X?" sin saber cómo se resuelve esa respuesta (Stripe, manual, lo que sea).
- Regla general:
  - `cut_paste`, `subtitles` → siempre disponibles, sin entitlement (capa gratuita).
  - `shorts_ai` (detección de emociones/shorts) → requiere entitlement activo (capa premium).
- Las **donaciones** ("dame un café") son un flujo separado dentro de Billing, sin relación con entitlements — no desbloquean nada, no gatean features.

## Frontera con cutloom-web

El procesamiento pesado de video (cortar, timeline, exportar, transcripción con Whisper) ocurre client-side en `cutloom-web`. Este backend solo entra en juego donde el cliente no puede resolverlo solo: persistencia multi-dispositivo, OAuth de publicación, y el pipeline de Shorts Intelligence (que corre en este servidor por requerir SenseVoice y un LLM).
