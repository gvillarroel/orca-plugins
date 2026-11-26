# Orca Plugins

**Pi Durable** añade un listado de agentes en inglés a Orca. Al seleccionar un agente local se abre **Pi Chat** en una pestaña central del workspace. **Details** muestra el historial guardado en SQLite y **Edit** permite cambiar las instrucciones, el nombre y el modelo conservando el identificador. [Guía completa de Pi Durable e instalación en inglés](plugins/pi-durable/README.md)

## Instalar Pi Durable

**[Guía de instalación en Windows](docs/instalacion.md)**. Explica cómo añadir el catálogo a tu perfil habitual de Orca, instalar Pi Durable, iniciar su servicio local y comprobar el primer chat con el modelo `demo`. También incluye el comando para volver a iniciar el servicio después de reiniciar Windows.

Para encontrar los plugins de este repositorio, abre **Settings → Plugins → … → Catalog sources…**. Añade `https://github.com/gvillarroel/orca-plugins.git` con la rama `main`. El catálogo aparecerá como **Orca Plugins**. [Actualizar una instalación anterior de Pi Durable](plugins/pi-durable/README.md#upgrade-an-existing-installation)

En una pestaña nativa puedes mencionar archivos con `@`. Con un perfil que admite herramientas, Pi puede leer un archivo del workspace y Orca muestra la operación junto a la respuesta. [Captura de la lectura en Orca](docs/pi-durable/native-tool.png)

## Evolucionar y borrar agentes

En **Details → Evolve** escribe un requisito y pulsa **Generate proposal**. Un agente editor recibe el código del agente seleccionado y prepara una nueva función JavaScript. Puedes elegir el modelo del editor por separado y usar **Add an example** para fijar un mensaje y la respuesta que esperas. El servicio ejecuta los ejemplos y comprueba que la propuesta conserve el comportamiento cubierto por las pruebas anteriores.

Para probarlo sin credenciales, selecciona el editor `demo` y escribe `Cuando diga "estado", responde "listo"`. Revisa **Proposed script** y **Passed checks**, pulsa **Apply change** y escribe `estado` en el mismo chat de Orca. El agente responderá `listo`, incluso después de reiniciar el servicio. **Active script → Restore previous script** recupera la versión anterior. El editor de demostración admite respuestas a frases exactas y comandos para contar palabras. Un editor con modelo configurado puede generar otras transformaciones de texto. [Guía de evolución](plugins/pi-durable/README.md#evolve-a-local-agent)

Para borrar un agente local, abre **Details → Edit → Delete agent…** y confirma el nombre y el ID que muestra Orca. El agente desaparece del listado, deja de aceptar mensajes y su ID queda reservado. Los historiales previos se conservan en SQLite y en las pestañas de Orca.

Cada plugin se distribuye desde su carpeta en `plugins/<id>/`. El catálogo raíz fija la versión, el commit y el hash de cada publicación. [Catálogo](orca-catalog.json) · [Licencia MIT](LICENSE)
