# 🎵 Vibe Manager - Système de Playlist Interactive

Ce projet permet à un DJ de laisser son public proposer et voter pour des musiques en temps réel via un simple QR Code.

## 🚀 Installation Rapide (A-Z)

Si tu pars de zéro, ouvre ton terminal (**PowerShell** ou **CMD**) et exécute ces étapes :

### 1. Préparation du dossier
```powershell
mkdir vibe-manager
cd vibe-manager
```

### 2. Initialisation et Dépendances
```powershell
npm init -y
npm install express socket.io sqlite3 sqlite
```

### 3. Structure des fichiers
* `server.js` (Le cœur du système avec logique Auto-Next)
* `auto.bat` (Le raccourci de lancement)
* `public/` (Dossier contenant les interfaces)
    * `index.html` (Interface invités - Mobile)
    * `admin.html` (Interface DJ / Mode Auto / Copier titres)
    * `live.html` (Interface Vidéoprojecteur - QR dynamique)
    * `logo.png` (Ton QR Code ou logo)

---

## ⚡ Lancement du serveur

### Méthode Recommandée
Double-clique sur **`auto.bat`**. Le serveur sera accessible sur :
* **Local :** `http://localhost:3000`
* **Réseau (Invités) :** `http://[TON_IP_LOCALE]:3000`

---

## 🎮 Fonctionnalités Spéciales

### 1. Mode Automatique (Smart DJ)
Activé depuis `admin.html`. Le serveur surveille la liste : dès qu'un morceau est libre en position "Prochainement", il sélectionne automatiquement le titre ayant le plus de votes. Plus besoin de surveiller l'écran !

### 2. QR Code Dynamique (Live)
L'interface `live.html` gère l'affichage intelligemment :
* **Liste vide :** Le QR Code s'affiche en grand au centre pour inciter les gens à scanner.
* **Liste remplie :** Le QR Code glisse dans un coin pour laisser place au Top 5.

### 3. Gestion du "Deuxième Passage"
Pour éviter la lassitude, les morceaux en deuxième passage apparaissent avec une bordure **Jaune** distinctive sur tous les écrans (Admin, Live et Client).

### 4. Workflow DJ Rapide
Dans l'interface Admin, un bouton **"Copier"** est présent à côté de chaque titre pour coller instantanément le nom du morceau dans ton logiciel de mix (VirtualDJ, Rekordbox, Serato).

---

## 🛠️ Contenu du fichier `auto.bat`

```batch
@echo off
title Vibe Manager Server
echo Lancement du systeme de vote...
cd /d %~dp0
node server.js
pause
```

---

## ⚠️ Conseils pour la soirée
* **IP Fixe :** Essaie de fixer l'IP de ton ordinateur dans les réglages de ta box pour que le QR Code ne change pas si l'ordi redémarre.
* **Pare-feu :** Si les invités n'arrivent pas à se connecter, vérifie que le port **3000** est autorisé dans ton pare-feu Windows/Linux.
* **Reset :** Pour vider totalement la liste entre deux soirées, supprime le fichier `database.sqlite`.

