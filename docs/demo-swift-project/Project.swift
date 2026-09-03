import ProjectDescription

let project = Project(
    name: "AgentMonitoringDemo",
    targets: [
        .target(
            name: "AgentMonitoringDemo",
            destinations: .iOS,
            product: .app,
            bundleId: "com.indextrown.AgentMonitoringDemo",
            deploymentTargets: .iOS("18.0"),
            infoPlist: .extendingDefault(with: [
                "UILaunchScreen": .dictionary([:])
            ]),
            sources: ["Sources/**"],
            dependencies: []
        ),
        .target(
            name: "AgentMonitoringDemoTests",
            destinations: .iOS,
            product: .unitTests,
            bundleId: "com.indextrown.AgentMonitoringDemoTests",
            deploymentTargets: .iOS("18.0"),
            infoPlist: .default,
            sources: ["Tests/**"],
            dependencies: [
                .target(name: "AgentMonitoringDemo")
            ]
        )
    ]
)
