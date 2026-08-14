// Punto de entrada de los esquemas Drizzle de todos los bounded contexts.
// Cada contexto exporta sus tablas y se re-exportan aquí para que
// drizzle-kit las descubra en un único archivo raíz.
export * from '../../../identity/infrastructure/db/schema'
