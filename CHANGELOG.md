# Changelog

## 0.2.2 — 2026-10-04

### Corregido
- **Detección de Claude y Kimi en Windows.** Los globales npm se instalan como
  shims `.cmd`; `spawnCli('claude', ...)` y `spawnCli('kimi', ...)` fallaban en
  silencio porque el wrapper `cmd.exe` solo se activaba para rutas que ya
  terminaban en `.cmd`. El nuevo helper `resolveCmd(name)` prueba el nombre
  plano primero (funciona en Linux/Mac y ejecutables nativos de Windows) y, si
  falla, reintenta con `name.cmd` antes de declarar el CLI como no instalado.
- **Traspaso de terminal para Claude y Kimi en Windows.** `handoff.js` ahora
  usa el `resolvedCmd` detectado en el descubrimiento y aplica el mismo wrapper
  `cmd.exe /d /s /c` que ya se usaba para Codex.
- **Detección de Codex en Linux/Mac.** `detectCodex` invocaba `codex.cmd`
  directamente, lo que fallaba fuera de Windows. Ahora pasa también por
  `resolveCmd`.

### Cambiado
- Eliminadas las advertencias de versión. La comprobación contra versiones
  hardcodeadas generaba falsos positivos en cualquier actualización de los CLIs
  y no aportaba información accionable. La herramienta funciona con cualquier
  versión instalada.

## 0.2.1 — 2026-09-29

### Cambiado
- Documentación revisada: el README presenta el problema que resuelve
  inharness y los problemas identificados durante el stress test previo a la
  publicación, con su solución.
- `package.json`: ruta del ejecutable normalizada (`bin/inharness.js`).

Sin cambios de comportamiento en las skills.

## 0.2.0 — 2026-09-28

Cambios en las tres variantes de la skill (`skills/claude/SKILL.md`,
`skills/codex/SKILL.md`, `skills/kimi/inharness.md`). `syncSkills` las
reinstala automáticamente en el siguiente arranque de `inharness` al detectar
la nueva versión.

### Añadido
- **Respaldo por cupo.** El mapeo del Paso 1 incluye un respaldo en otro CLI
  para cada nivel. Nuevo protocolo "Fila cortada por cupo" en el Paso 3:
  detectar el límite (usage limit, quota, rate limit, 403/429 de cupo o falta
  de respuesta), marcar la fila `bloqueada-cupo` con hora y mensaje, relanzarla
  en el respaldo continuando desde los ficheros parciales y, si el respaldo
  también está limitado, dejarla bloqueada. Al retomar, las filas
  `bloqueada-cupo` tienen prioridad.
- **Estado `bloqueada-cupo`** en `.inharness/assignment.md`, también tenido en
  cuenta al ofrecer continuar una sesión anterior.
- **Ficheros compartidos.** El Paso 2 prohíbe asignar a filas paralelas los
  ficheros que usan varias filas (configuración de tests, manifiestos y
  lockfiles, módulos comunes): los prepara el orquestador, y las filas piden
  los cambios en su resumen.
- **Aviso de red en Codex.** El sandbox `workspace-write` no tiene red: el
  orquestador instala las dependencias antes, deja para sí u otro CLI las
  pruebas con red y lo indica en el prompt. En la variante de Codex (Codex
  como orquestador), las filas que necesitan red se asignan a Claude o Kimi.

### Cambiado
- **"Comprobación mecánica" pasa a "comprobación proporcional".** Para filas
  que solo producen documentos o datos, sigue bastando con el código de
  salida y que el fichero exista y no esté vacío. Para filas que producen
  código, el orquestador ejecuta los tests o el comando que lo demuestre. El
  autoinforme del sub-agente nunca cuenta como prueba.
- **Regla de verificación.** La fila que audita a otra contrasta resultados
  reales (ejecuta tests, compara salidas) en lugar de leer el resumen.

### Contexto
Los cuatro cambios responden a problemas identificados durante el stress test
previo a la publicación, orquestando desarrollos con decenas de tareas en
paralelo entre los tres CLIs: un cupo de uso agotado a mitad de una tarea,
entregables dados por buenos con errores reales, una edición concurrente en un
fichero compartido que rompió varias tareas a la vez, y fallos silenciosos de
instalación de dependencias en el sandbox de Codex.

## 0.1.1 — 2026-09-26

Primera versión publicada: detección de CLIs por suscripción, elección de
orquestador, traspaso real del terminal e instalación de las skills nativas en
Claude Code, Codex y Kimi Code.
