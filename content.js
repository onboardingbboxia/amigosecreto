'use strict';
// Preguntas de la trivia y retos diarios. Las respuestas (a) solo viven en el servidor.
const TRIVIA = [
 {q:"¿En qué país nació la tradición del árbol de Navidad decorado?",o:["Alemania","Italia","Estados Unidos","Finlandia"],a:0},
 {q:"¿Cómo se llaman los Reyes Magos?",o:["Melchor, Gaspar y Baltasar","Mateo, Gabriel y Benito","Melquiades, Gonzalo y Baltasar","Nicolás, Gaspar y Martín"],a:0},
 {q:"¿De qué país es originaria la flor de Nochebuena (poinsettia)?",o:["España","México","Colombia","Perú"],a:1},
 {q:"¿Cuántos renos tiene Santa en la tradición clásica, sin contar a Rodolfo?",o:["6","8","9","12"],a:1},
 {q:"¿Qué día se celebra el Día de Reyes?",o:["25 de diciembre","1 de enero","6 de enero","2 de febrero"],a:2},

 {q:"«Noche de paz» se escribió originalmente en…",o:["Inglés","Latín","Alemán","Francés"],a:2},
 {q:"En España se comen 12 uvas en…",o:["Nochebuena","Año Nuevo","Día de Reyes","Navidad al mediodía"],a:1},
 {q:"¿Cómo se llama el niño protagonista de «Mi pobre angelito»?",o:["Kevin","Kyle","Kenny","Kurt"],a:0},
 {q:"¿Qué ciudad de Finlandia se presenta como el hogar de Papá Noel?",o:["Helsinki","Turku","Rovaniemi","Oulu"],a:2},
 {q:"¿Qué personaje de Charles Dickens detesta la Navidad?",o:["Oliver Twist","Ebenezer Scrooge","David Copperfield","Tiny Tim"],a:1},

 {q:"¿En qué país es costumbre cenar pollo frito de KFC en Navidad?",o:["Corea del Sur","Japón","Filipinas","Tailandia"],a:1},
 {q:"El panettone es un pan dulce típico de…",o:["Milán","Viena","Lyon","Lisboa"],a:0},
 {q:"¿Cuántos días dura la Novena de Aguinaldos en Colombia?",o:["7","9","12","24"],a:1},
 {q:"¿Qué bebida navideña chilena lleva café, leche, canela y aguardiente?",o:["Rompope","Ponche crema","Cola de mono","Coquito"],a:2},
 {q:"¿Qué santo inspiró la figura de Santa Claus?",o:["San Nicolás","San Martín","San Francisco","San Jorge"],a:0},

 {q:"¿Qué se esconde dentro de la Rosca de Reyes?",o:["Una moneda de oro","Una figurita del Niño Dios","Un anillo","Una almendra"],a:1},
 {q:"¿En qué año se estrenó «Mi pobre angelito»?",o:["1987","1990","1993","1996"],a:1},
 {q:"¿Bajo qué planta es tradición darse un beso?",o:["Acebo","Muérdago","Hiedra","Pino"],a:1},
 {q:"Según el villancico, ¿qué hacen los peces en el río?",o:["Nadan y nadan","Beben y beben","Cantan y bailan","Saltan y saltan"],a:1},
 {q:"En Italia, ¿quién trae regalos a los niños el 6 de enero?",o:["La Befana","Krampus","Olentzero","Tió de Nadal"],a:0},

 {q:"¿Qué día es la Nochebuena?",o:["23 de diciembre","24 de diciembre","25 de diciembre","31 de diciembre"],a:1},
 {q:"¿Qué actor interpretó al Grinch en la película de 2000?",o:["Robin Williams","Adam Sandler","Jim Carrey","Will Ferrell"],a:2},
 {q:"¿Cómo se llama el reno de la nariz roja?",o:["Rodolfo","Cometa","Bailarín","Relámpago"],a:0},
 {q:"¿Qué celebran las Posadas en México?",o:["La llegada de los Reyes","El camino de María y José buscando posada","El fin de año","La cosecha de invierno"],a:1},
 {q:"El Krampus, que asusta a los niños traviesos, viene del folclor de…",o:["Los Alpes (Austria y Baviera)","Escocia","Grecia","Noruega"],a:0},

 {q:"¿En qué monte vive el Grinch?",o:["Monte Crumpit","Monte Nevado","Monte Quién","Monte Olimpo"],a:0},
 {q:"¿Qué personaje de Navidad es un tronco catalán que «hace caca» regalos?",o:["Caga Tió","Olentzero","La Befana","El Pare Noel"],a:0},
 {q:"¿Qué película de Navidad dirigió Tim Burton como productor y autor de la historia?",o:["El expreso polar","El extraño mundo de Jack","Elf","Klaus"],a:1},
 {q:"En «Elf», ¿quién interpreta a Buddy?",o:["Will Ferrell","Jack Black","Steve Carell","Owen Wilson"],a:0},
 {q:"¿Qué es el «aguinaldo» en muchos países de Latinoamérica?",o:["Un dulce de coco","Un pago extra de fin de año","Un tipo de piñata","Una misa de medianoche"],a:1},
];
const ROUND_SIZE = 5, ROUNDS = Math.ceil(TRIVIA.length/ROUND_SIZE), Q_SECONDS = 15;
const DAILY = [
 {e:"💚😠🎄",q:"¿Qué película es?",o:["El Grinch","Shrek","Elf","Klaus"],a:0},
 {e:"👦🏠😱🎄",q:"¿Qué película es?",o:["Mi pobre angelito","Matilda","Jumanji","Pesadilla antes de Navidad"],a:0},
 {e:"🦌🔴👃",q:"¿Qué canción es?",o:["Rodolfo, el reno","Jingle Bells","Feliz Navidad","Noche de paz"],a:0},
 {e:"🐟🌊🍷",q:"¿Qué villancico es?",o:["Los peces en el río","Campana sobre campana","El burrito sabanero","Mi burrito"],a:0},
 {e:"🧝📏🗽",q:"¿Qué película es?",o:["Elf","Santa Cláusula","Duendes al rescate","El expreso polar"],a:0},
 {e:"👻👻👻💰",q:"¿Qué historia es?",o:["Cuento de Navidad","Casper","Los cazafantasmas","La familia Addams"],a:0},
 {e:"🌙🤫⭐",q:"¿Qué villancico es?",o:["Noche de paz","Blanca Navidad","Adeste fideles","Los peces en el río"],a:0},
 {e:"🥁👦🐑",q:"¿Qué villancico es?",o:["El tamborilero","Mi burrito sabanero","Campanas de Belén","Arre borriquito"],a:0},
 {e:"⛄🎩✨",q:"¿Qué personaje es?",o:["Frosty","Olaf","Jack Frost","El abominable"],a:0},
 {e:"💀🎃🎄",q:"¿Qué película es?",o:["El extraño mundo de Jack","Coco","El cadáver de la novia","Beetlejuice"],a:0},
 {e:"🚂❄️🎅",q:"¿Qué película es?",o:["El expreso polar","Asesinato en el Orient Express","Frozen","Arthur Christmas"],a:0},
 {e:"🐴🌄🎶",q:"¿Qué villancico es?",o:["El burrito sabanero","Arre borriquito","Noche de paz","Campana sobre campana"],a:0},
 {e:"🎅⬇️🏙️",q:"¿Qué canción es?",o:["Santa Claus llegó a la ciudad","Feliz Navidad","Jingle Bell Rock","Rodolfo, el reno"],a:0},
 {e:"🔔🔔🏃🛷",q:"¿Qué canción es?",o:["Jingle Bells","Campana sobre campana","Last Christmas","Feliz Navidad"],a:0},
 {e:"❄️👸⛄",q:"¿Qué película es?",o:["Frozen","Enredados","Brave","Moana"],a:0},
 {e:"📮✉️🎁🪵",q:"¿Qué película animada es?",o:["Klaus","Arthur Christmas","El expreso polar","Pesadilla antes de Navidad"],a:0},
];
const DAILY_PTS = 15;
module.exports = { TRIVIA, ROUND_SIZE, ROUNDS, Q_SECONDS, DAILY, DAILY_PTS };
