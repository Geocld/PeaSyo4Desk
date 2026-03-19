import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Slider,
} from "@heroui/react";
import { useTranslation } from "next-i18next";

type FsrModalProps = {
  show: boolean;
  sharpness: number;
  min: number;
  max: number;
  step: number;
  onSharpnessChange: (value: number | number[]) => void;
  onClose: () => void;
  onConfirm: () => void;
  onReset: () => void;
};

function FsrModal(props: FsrModalProps) {
  const { t } = useTranslation("stream");

  return (
    <Modal isOpen={props.show} onClose={props.onClose} size="md">
      <ModalContent>
        <>
          <ModalHeader>{t("FSR adjustment")}</ModalHeader>
          <ModalBody className="gap-4">
            <Slider
              label={t("FSR sharpness")}
              minValue={props.min}
              maxValue={props.max}
              step={props.step}
              value={props.sharpness}
              onChange={props.onSharpnessChange}
              showTooltip
            />
            <div className="text-sm text-default-500">
              {t("Current FSR sharpness")}: {props.sharpness.toFixed(2)}
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={props.onReset}>
              {t("Reset")}
            </Button>
            <Button color="primary" onPress={props.onConfirm}>
              {t("Confirm")}
            </Button>
          </ModalFooter>
        </>
      </ModalContent>
    </Modal>
  );
}

export default FsrModal;
