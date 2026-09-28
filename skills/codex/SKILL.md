---
name: "inharness"
description: "Orquesta una tarea entre Codex (tu mismo), Claude y Kimi por suscripcion (sin API keys), repartiendo por complejidad/coste y ejecutando con aprobacion del usuario. Usar cuando el usuario pida trabajo multiagente, reparte esto entre modelos, mencione $inharness, o pida usar Claude/Kimi/Codex juntos para una tarea."
---

# inharness — orquestacion multi-CLI por suscripcion (desde Codex)

**Cada vez que se active esta skill** (por `$inharness`, o porque la tarea
pide trabajo multiagente), tu primera linea de respuesta -antes de
descubrimiento, antes de nada- es una confirmacion explicita: "inharness
activo - orquestando entre Codex, Claude y Kimi." Es la unica señal fiable
que tiene el usuario de que esto se disparo y no es una respuesta normal;
no la omitas nunca, ni siquiera si ya la diste antes en la misma sesion
(cada activacion se anuncia).

Tu (esta sesion de Codex) eres el orquestador. No delegues la decision de
reparto a otro CLI - razonas tu mismo, y solo invocas a Claude/Kimi por
linea de comandos para EJECUTAR las piezas que les toquen. Nunca uses
`--bare` en Claude ni pases API keys de ningun tipo: todo corre por sesion
de suscripcion ya logueada.

**Claude y Kimi son binarios de linea de comandos YA instalados y YA
autenticados por suscripcion en esta maquina** - se invocan como cualquier
otro comando de terminal (`claude ...`, `kimi ...`), nunca por red, nunca
con una clave de API, nunca eligiendo un "proveedor". Si en algun momento
te encuentras queriendo pedirle al usuario una API key, una clave, o "que
proveedor/modelo de API usar", te has desviado por completo del proposito
de esta skill - para y vuelve a leer esto.

**Si un comando de shell de esta skill pide aprobacion al usuario**: antes
de lanzarlo, di en una frase que vas a ejecutar y por que (comprobar que
modelos hay disponibles via el CLI ya instalado - sin red, sin
credenciales) para que lo apruebe con confianza. **Si el usuario cancela
esa aprobacion o el comando falla**: para ahi mismo y preguntale
explicitamente que prefiere hacer - nunca sigas adelante rellenando el
hueco con una suposicion (como pedir una API key); es preferible preguntar
que inventar un camino alterno.

## Memoria compartida (carpeta unica, obligatoria)

Todo el estado vive en `.inharness/` dentro del directorio de trabajo
actual (creala si no existe) - es la misma convencion que usan las skills
equivalentes de Claude Code y Kimi, para que cualquiera de los tres pueda
retomar el trabajo:

- `.inharness/discovery.md` - resultado del ultimo Paso 0: CLIs disponibles,
  catalogo de modelos, que modelos pasaron preflight con exito, y fecha/hora.
  Es la cache que evita repetir descubrimiento en cada activacion.
- `.inharness/task.md` - tarea original, analisis, mapeo de tiers aprobado.
- `.inharness/assignment.md` - tabla de estado por fila (id, rol, tier,
  cli/modelo resuelto, archivos, depende-de, estado: pendiente/en curso/
  hecho/fallido/bloqueada-cupo). Actualizala tras cada fila, no al final.
- `.inharness/log/<id>-<cli>.log` - salida cruda de cada llamada.

Si `.inharness/assignment.md` ya existe con filas pendientes o
`bloqueada-cupo`, ofrece
continuar desde ahi en vez de replanificar desde cero.

## Eficiencia (lean, obligatorio - no es opcional)

El proposito entero de esto es alargar el cupo de las suscripciones, no
gastarlo en idas y venidas. Cada salto a otro CLI cuesta cupo de ESA
suscripcion y tokens de esta sesion - tratalos como recurso escaso:

- **Cachea el descubrimiento**: si `.inharness/discovery.md` existe y es de
  esta misma sesion de trabajo, NO repitas el Paso 0 completo - leelo y
  sigue. Solo refrescalo si: el usuario lo pide, es una tarea claramente
  distinta, o un comando real fallo por algo que el discovery deberia haber
  cazado.
- **Cachea el preflight**: si un modelo ya se probo con exito en
  `.inharness/discovery.md`, no lo vuelvas a probar antes de reusarlo.
- **Prompts a sub-agentes cortos y concretos**: la tarea y el alcance
  exactos, nada mas - no copies las reglas de esta skill en el prompt.
- **Verifica con el metodo mas barato que baste**: lee el diff o el archivo
  concreto, corre el test dirigido - no releas todo ni relances la suite
  completa si no hace falta.
- **Menos filas, mientras cada una siga siendo verificable por separado**:
  cada fila de mas en otro CLI es un arranque+cierre de sesion completo.
- **No narres en prosa cada paso propio**: informa solo lo que hace falta
  para aprobar/decidir y los resultados/fallos - no repitas el contenido de
  esta skill de vuelta.
- **Paralelo cuando no hay dependencia**: si dos o mas filas no dependen
  entre si, lanza esas llamadas a Claude/Kimi en paralelo (procesos en
  segundo plano) en vez de esperar una a una en secuencia. Solo esperas de
  verdad a una fila cuando otra depende de ella.
- **Comprobacion proporcional, no narrada**: tras cada llamada, valida con
  lo minimo que baste segun lo que produce la fila. Si solo produce un
  documento o un archivo de datos, basta con el codigo de salida y que el
  archivo exista y no este vacio. Si produce **codigo**, el codigo de salida
  no prueba nada: ejecuta tu los tests o el comando que demuestre que
  funciona y lee su resultado. **Nunca des por bueno el autoinforme del
  sub-agente** ("tests en verde", "hecho"): es una afirmacion, no una
  prueba. Actualiza `.inharness/assignment.md` con
  una edicion de una linea por fila - no lo reescribas entero ni lo narres
  salvo que algo falle o necesite tu decision.

## Paso 0 - Descubrimiento en caliente

No asumas un catalogo de dias/sesiones anteriores, pero SI reusa el de esta
misma sesion si ya existe (ver "Eficiencia" arriba). Si toca refrescarlo:

```bash
kimi provider list
kimi provider list --json
claude --version
```

Verificacion de suscripcion (nunca API): Kimi debe mostrar `source=oauth`
en `provider list`; Claude, si el entorno tiene `ANTHROPIC_API_KEY` seteada
puede estar en modo API - avisa y exclúyela si es asi. Tu (Codex) ya estas
autenticado por esta sesion.

**Aviso de version**: si `kimi --version` o `claude --version` difieren de
las ultimas verificadas con esta skill (Kimi 2.1.1, Claude 2.1.268),
dilo explicitamente antes de continuar - la sintaxis de abajo se probo
contra esas versiones.

**Preflight de modelos**: un modelo listado puede no estar habilitado en el
plan real (visto con `kimi-for-coding-highspeed`: aparece listado pero da
401 al invocarlo). Antes de comprometerte a un modelo que no hayas usado ya
en esta sesion, lanzale un prompt trivial de una linea para confirmar que
responde.

## Paso 1 - Mapeo de modelos por complejidad (una vez, no por tarea)

```
alta  : <cli>/<modelo> [@ esfuerzo]   (puede haber 2+)
media : <cli>/<modelo> [@ esfuerzo]
baja  : <cli>/<modelo> [@ esfuerzo]
```

No pongas por defecto el modelo mas nuevo/nombrado en "alta" solo por su
nombre - mira los metadatos reales del catalogo (effort por defecto,
contexto). Muestralo en 3-4 lineas, nunca en parrafos.

Para cada nivel, anota tambien un **respaldo** en otro CLI (p. ej.
`media: kimi/kimi-for-coding · respaldo: claude/sonnet`). Las suscripciones
tienen cupos (ventanas de 5 horas, limites semanales) y se agotan a mitad
de trabajo: el respaldo decidido de antemano evita improvisar cuando pase
(ver "Fila cortada por cupo" en el Paso 3).

## Paso 2 - Entender la tarea y proponer el reparto

2-3 frases: que tan acotada esta la tarea y por que el numero de filas
propuesto es el que hace falta (nunca una plantilla fija de roles). Cada
fila: que hace (frase corta), tier, archivos (sin solape - usa
depends_on si dos filas comparten archivo), de que depende.

**Ficheros compartidos: solo los toca el orquestador.** El "sin solape" no
basta con los ficheros que usan varias filas a la vez aunque ninguna los
"posea": configuracion de tests (`conftest.py`, `pytest.ini`,
`jest.config.*`), manifiestos y dependencias (`pyproject.toml`,
`package.json`, lockfiles) y modulos comunes que importan varias filas. No
los asignes a filas que corren en paralelo: preparalos tu antes de
lanzarlas, o despues con lo que pidan. Indica en el prompt de cada fila que
no los modifique y que, si necesita un cambio, lo diga en su resumen.

Regla dura: si una fila audita/testea el trabajo de otra, resuelvela a un
CLI DISTINTO al de la fila que produjo ese trabajo. La fila de verificacion
contrasta resultados reales (ejecuta los tests, compara la salida con lo
pedido) y no se limita a leer el resumen de la fila verificada.

Presentalo al usuario y espera su aprobacion explicita (o edicion del
mapeo) antes de ejecutar nada.

## Paso 3 - Ejecutar (solo lo aprobado)

- **Fila resuelta a Codex (tu mismo)**: hazla directamente con tus propias
  herramientas, no te invoques a ti mismo como subproceso. Si tu sesion
  corre en el sandbox `workspace-write` **no tienes red**: no puedes
  instalar dependencias (`pip`, `npm`), descargar nada ni probar contra
  servicios o webs en vivo. Las filas que lo necesiten asignalas a Claude o
  a Kimi, o pide al usuario que ejecute ese paso.
- **Fila resuelta a Claude**:
  ```bash
  claude -p "<prompt completo y autocontenido>" \
    --model <haiku|sonnet|opus> \
    --permission-mode acceptEdits \
    --add-dir "<directorio de trabajo>"
  ```
  Nunca `--bare` (fuerza API key en vez de suscripcion).
- **Fila resuelta a Kimi**:
  ```bash
  kimi -m kimi-code/<modelo> -p "<prompt>"
  ```
  Alias completo obligatorio. Nunca `--auto` ni `-y` en modo `-p`. Kimi no
  permite fijar el nivel de esfuerzo por invocacion - usa el que traiga el
  modelo por defecto.

Verifica cada fila (leer el resultado, correr tests si aplica) antes de dar
la siguiente por buena si depende de ella. Actualiza
`.inharness/assignment.md` inmediatamente tras cada fila.

**Fila cortada por cupo.** Si un CLI responde con un limite de uso ("usage
limit", "quota", "rate limit", un 403/429 que hable de cupo o de la ventana
de 5 horas) o se queda sin responder dentro de su tiempo maximo:
1. Marca la fila `bloqueada-cupo` en `.inharness/assignment.md`, con la hora
   y el mensaje recibido.
2. Relanzala en el **respaldo** de su nivel (Paso 1). Dale en el prompt lo
   que la fila anterior ya dejo hecho (ficheros parciales) para que continue
   y no empiece de cero. Avisa al usuario en una linea.
3. Si el respaldo tambien esta limitado, deja la fila en `bloqueada-cupo` y
   dilo. Al retomar el trabajo mas tarde, las filas `bloqueada-cupo` se
   reintentan antes que las pendientes.

## Paso 4 - QA final y cierre

Revisa el conjunto contra lo pedido, reporta que hizo cada fila (rol -
cli/modelo - resultado) en una lista corta, y señala cualquier fallo o
modelo excluido (401, version no verificada) en vez de omitirlo. Deja
`.inharness/assignment.md` con el estado final real.
