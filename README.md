Chaukas AI — UPI Fraud Protection Ecosystem 

[🚀 Click here for Live Demo](https://swaminidhavane-bvcoew.github.io/Chaukas-AI-Project-/upi-app/index.html)

Chaukas AI is a dual-layered security system designed to detect and prevent UPI transaction fraud in real-time. By combining Behavioral Biometrics with Gemini AI the system creates a unique security profile for users to distinguish between legitimate owners and unauthorized actors.

 Core Functionalities
- **Behavioral Analysis:** Tracks keystroke dynamics and mouse movements to establish a user baseline.
- **AI Risk Assessment:** Integrated **Gemini 1.5 Flash** to analyze behavioral data and generate real-time risk scores.
- **Cross-Device Security:** A **Firebase-powered alert
- system** that triggers notifications to a trusted device for high-risk transactions.

 Project Structure & Deliverables
The project consists of **14 core files** organized into two primary modules:

 1. Chrome Extension (6 Files)
*Located in the `/extension` folder. Built using **Manifest V3**.*
- **manifest.json:** Extension configuration and permissions.
- **background.js:** Service worker handling API calls to Gemini and Firebase.
- **content_script.js:** Monitors user behavior (keystroke/mouse) on payment pages.
- **popup.html & popup.js:** The user interface for the security dashboard.
- **icon.png:** Extension branding.

### 2. UPI Web Ecosystem (8 Files)
*Located in the `/upi-app` folder. A responsive, mobile-first simulation.*
- **index.html & dashboard.html:** User login and main account overview.
- **send.html & confirm.html:** The payment flow integrated with behavioral tracking.
- **success.html:** Transaction completion state.
- **history.html:** Detailed log of previous transactions and security flags.
- **monitor.html:** The "Trusted Device" view for authorizing suspicious payments.
- **style.css:** Centralized styling for the entire responsive web app.

 Tech Stack
- AI Engine: Gemini 1.5 Flash API
- Backend/Database: Firebase Realtime Database
- Frontend: HTML5, CSS3, Vanilla JavaScript
- Architecture: Chrome Extension Manifest V3

 👥 Team Credits
This project was a collaborative effort where I served as the Team Lead.
Jyoti Koswal, Tanisha Gundecha, Aarya Ghogare, Shrawani Jamdade, Swamini Dhavane
