# Configurateur d'affaires — V4 responsive + vue de coupe 2D

Prototype local pour pliage / profilage.

## Nouveautés V4

- Interface responsive : l'écran s'adapte mieux au PC atelier, laptop, tablette et mobile.
- La zone principale d'aperçu affiche d'abord une **vue de coupe 2D cotée**, plus proche d'un plan AutoCAD.
- Le développé à plat reste visible à droite / dessous selon la largeur de l'écran.
- Les canvases sont redimensionnés automatiquement quand la fenêtre change de taille.
- Les saisies restent dynamiques selon la gamme et l'article sélectionnés.

## Lancement Windows

Double-cliquer sur :

```bat
LANCER_ICI_WINDOWS.bat
```

Puis garder la fenêtre noire ouverte. Le navigateur s'ouvre sur :

```text
http://127.0.0.1:8000
```

## Lancement Mac / Linux

```bash
python3 app.py
```

## Important

Ne pas ouvrir directement `static/index.html` en usage normal. Le mode fichier existe en secours, mais les exports DXF/fiche fonctionnent mieux via le serveur Python.

## À recalibrer pour une vraie version atelier

Les formes et les cotations sont indicatives. Pour rendre le configurateur fiable, il faudra définir pour chaque article :

- l'ordre exact des segments ;
- les conventions de cotation ;
- les angles et sens de pli ;
- les corrections atelier selon matière / épaisseur / outil / rayon ;
- les règles de contrôle et limites machine.
