@echo off
title Orvia Companion
python "%~dp0orvia-companion-windows.py"
if errorlevel 1 (echo Python not found. Install Python from python.org and tick "Add python.exe to PATH". & pause)
